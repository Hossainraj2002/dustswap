# Read-only public route/build API requests and a LOCAL OP fork. Never signs or broadcasts.
param(
    [string]$RpcUrl = $(if ($env:OPTIMISM_MAINNET_RPC_URL) { $env:OPTIMISM_MAINNET_RPC_URL } else { 'https://mainnet.optimism.io' }),
    [ValidateRange(1, 1000)][int]$SlippageBps = 500
)

$ErrorActionPreference = 'Stop'
$opContractRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$opTaker = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f'
$opBuyer = '0xc76044783D69e3478300d4477e2649F882604776'
$opWeth = '0x4200000000000000000000000000000000000006'
$opUsdc = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
$opKyber = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
$opBuyAmount = '1000000000000000' # 0.001 WETH for each real acquisition.
$opHeaders = @{ Accept = 'application/json'; 'x-client-id' = 'dustswap' }
$opBasket = @(
    @{ label = 'wstETH'; token = '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb' },
    @{ label = 'rETH'; token = '0x9bcef72be871e61ed4fbbc7630889bee758eb81d' },
    @{ label = 'SNX'; token = '0x8700daec35af8ff88c16bdf0418774cb3d7599b4' },
    @{ label = 'VELO v2'; token = '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db' },
    @{ label = 'WBTC'; token = '0x68f180fcCe6836688e9084f035309E29Bf0A2095' }
)

function Get-OpBasketPayload {
    param([string]$TokenIn, [string]$TokenOut, [string]$Amount, [string]$Sender)
    Start-Sleep -Milliseconds 300
    $quoteUrl = "https://aggregator-api.kyberswap.com/optimism/api/v1/routes?tokenIn=$TokenIn&tokenOut=$TokenOut&amountIn=$Amount"
    $quote = Invoke-RestMethod -Uri $quoteUrl -Headers $opHeaders -TimeoutSec 30
    if ([int]$quote.code -ne 0 -or !$quote.data.routeSummary -or $quote.data.routerAddress -ine $opKyber) {
        throw 'Kyber basket quote did not return the canonical router.'
    }
    if ($quote.data.routeSummary.tokenIn -ine $TokenIn -or $quote.data.routeSummary.tokenOut -ine $TokenOut -or [bigint]$quote.data.routeSummary.amountIn -ne [bigint]$Amount) {
        throw 'Kyber basket quote returned mismatched assets or amount.'
    }
    $body = @{
        routeSummary = $quote.data.routeSummary
        sender = $Sender
        recipient = $Sender
        slippageTolerance = $SlippageBps
        source = 'dustswap'
    } | ConvertTo-Json -Depth 100 -Compress
    Start-Sleep -Milliseconds 300
    $build = Invoke-RestMethod -Uri 'https://aggregator-api.kyberswap.com/optimism/api/v1/route/build' -Method Post -Headers $opHeaders -ContentType 'application/json' -Body $body -TimeoutSec 30
    $target = $(if ($build.data.routerAddress) { $build.data.routerAddress } else { $quote.data.routerAddress })
    if ([int]$build.code -ne 0 -or $target -ine $opKyber -or $build.data.data -notmatch '^0x[0-9a-fA-F]{8,}$') {
        throw 'Kyber basket build failed canonical target/calldata checks.'
    }
    if ($build.data.transactionValue -and [bigint]$build.data.transactionValue -ne 0) { throw 'Native-value basket payload is unsupported.' }
    $estimated = [bigint]$(if ($build.data.amountOut) { $build.data.amountOut } else { $quote.data.routeSummary.amountOut })
    if ($estimated -le 0) { throw 'Kyber basket build returned zero output.' }
    return @{ target = $target; data = $build.data.data; amountOut = $estimated; venues = @($quote.data.routeSummary.route | ForEach-Object { $_ } | ForEach-Object { $_.exchange } | Select-Object -Unique) }
}

$opChainId = & cast chain-id --rpc-url $RpcUrl
if ($LASTEXITCODE -ne 0 -or "$opChainId".Trim() -ne '10') { throw 'RPC must be OP Mainnet.' }
$opBlock = & cast block-number --rpc-url $RpcUrl
if ($LASTEXITCODE -ne 0) { throw 'Could not read basket fork block.' }
$opLegs = @()
foreach ($opAsset in $opBasket) {
    $opBuy = Get-OpBasketPayload -TokenIn $opWeth -TokenOut $opAsset.token -Amount $opBuyAmount -Sender $opBuyer
    # A 5% buy slippage floor safely covers this 90% exact selection. Unselected purchase
    # remainder stays with the buyer; the test accounts for it separately from sweep refunds.
    $opSelected = ($opBuy.amountOut * 90 / 100).ToString()
    $opSell = Get-OpBasketPayload -TokenIn $opAsset.token -TokenOut $opUsdc -Amount $opSelected -Sender $opTaker
    $opLegs += @{
        label = $opAsset.label; token = $opAsset.token; buyAmount = $opBuyAmount
        buyTarget = $opBuy.target; buyData = $opBuy.data; buyVenues = $opBuy.venues
        amountIn = $opSelected; sellTarget = $opSell.target; sellSpender = $opSell.target
        sellData = $opSell.data; sellVenues = $opSell.venues
        minimum = ($opSell.amountOut * (10000 - $SlippageBps) / 10000).ToString()
    }
    Write-Output "Built real buy/sell payloads for $($opAsset.label): selected $opSelected units, expected $($opSell.amountOut) raw USDC."
}
$opFixture = @{ taker = $opTaker; buyer = $opBuyer; forkBlock = [long]"$opBlock".Trim(); tokenCount = 5; createdAt = [DateTime]::UtcNow.ToString('o'); tokens = $opLegs }
$opOut = Join-Path $opContractRoot 'out'
New-Item -ItemType Directory -Path $opOut -Force | Out-Null
$opFixture | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $opOut 'optimism-aggregator-basket-fixture.json')
Write-Output "Simulating five real purchased inputs in one local-router sweep at OP block $opBlock."

$opPreviousEnv = @{}
$opTestEnv = @{
    DUST_SWEEP_OPTIMISM_FORK_TESTS = '1'
    DUST_SWEEP_OPTIMISM_AGGREGATOR_BASKET_FORK_TESTS = '1'
    OPTIMISM_MAINNET_RPC_URL = $RpcUrl
    OPTIMISM_FORK_BLOCK = "$opBlock".Trim()
}
foreach ($opName in $opTestEnv.Keys) {
    $opPreviousEnv[$opName] = [Environment]::GetEnvironmentVariable($opName, 'Process')
    [Environment]::SetEnvironmentVariable($opName, $opTestEnv[$opName], 'Process')
}
Push-Location $opContractRoot
try {
    $opForkOutput = & forge test --match-contract DustSwapSweepRouterOptimismForkTest --match-test testForkAggregatorBasketFiveTokensOneSweep --evm-version cancun -vv
    $opForkExit = $LASTEXITCODE
    $opForkOutput | Write-Output
    if ($opForkExit -ne 0 -or !($opForkOutput -match '\[PASS\] testForkAggregatorBasketFiveTokensOneSweep\(\)')) {
        throw 'Real five-token aggregator basket did not execute successfully; do not treat quote availability or a skipped/missing test as execution proof.'
    }
} finally {
    Pop-Location
    foreach ($opName in $opTestEnv.Keys) {
        [Environment]::SetEnvironmentVariable($opName, $opPreviousEnv[$opName], 'Process')
    }
}
