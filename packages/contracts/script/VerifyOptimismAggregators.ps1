# Public quote/build API reads followed by local fork simulation. Never broadcasts.
param(
    [string]$RpcUrl = $(if ($env:OPTIMISM_MAINNET_RPC_URL) { $env:OPTIMISM_MAINNET_RPC_URL } else { 'https://mainnet.optimism.io' }),
    # Deterministic CREATE address of the exact router deployed by this Foundry test contract.
    [string]$TakerAddress = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
    [ValidateRange(1, 2000)][int]$SlippageBps = 500,
    # Optional common local fork block when combining separately generated fixtures.
    [ValidateRange(0, 9223372036854775807)][long]$ForkBlock = 0,
    # Optional ACTUAL deployed router. Selects deployed-router tests and never configures it.
    [string]$RouterAddress
)

$ErrorActionPreference = 'Stop'
$opContractRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$opWeth = '0x4200000000000000000000000000000000000006'
$opUsdc = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
$opAmount = '10000000000000000'
$opKyberAddress = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
$opLifiAddress = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
$opDeployed = ![string]::IsNullOrWhiteSpace($RouterAddress)
if ($opDeployed) { $TakerAddress = $RouterAddress }
if ($TakerAddress -notmatch '^0x[0-9a-fA-F]{40}$' -or $TakerAddress -match '^0x0{40}$') {
    throw 'TakerAddress must be a nonzero 20-byte hex address.'
}
$opChainId = & cast chain-id --rpc-url $RpcUrl
if ($LASTEXITCODE -ne 0 -or "$opChainId".Trim() -ne '10') { throw 'RPC must be OP Mainnet.' }
if ($ForkBlock -gt 0) {
    $opBlock = "$ForkBlock"
} else {
    $opBlock = & cast block-number --rpc-url $RpcUrl
    if ($LASTEXITCODE -ne 0) { throw 'Could not read fork block.' }
}

$opHeaders = @{ Accept = 'application/json'; 'x-client-id' = 'dustswap' }
$opQuoteUrl = "https://aggregator-api.kyberswap.com/optimism/api/v1/routes?tokenIn=$opWeth&tokenOut=$opUsdc&amountIn=$opAmount"
$opQuote = Invoke-RestMethod -Uri $opQuoteUrl -Headers $opHeaders -TimeoutSec 30
if ([int]$opQuote.code -ne 0 -or !$opQuote.data.routeSummary -or $opQuote.data.routerAddress -ine $opKyberAddress) {
    throw 'Kyber quote did not return the canonical OP router.'
}
$opBuildBody = @{
    routeSummary = $opQuote.data.routeSummary
    sender = $TakerAddress
    recipient = $TakerAddress
    slippageTolerance = $SlippageBps
    source = 'dustswap'
} | ConvertTo-Json -Depth 100 -Compress
$opBuild = Invoke-RestMethod -Uri 'https://aggregator-api.kyberswap.com/optimism/api/v1/route/build' -Method Post -Headers $opHeaders -ContentType 'application/json' -Body $opBuildBody -TimeoutSec 30
$opKyberTarget = $(if ($opBuild.data.routerAddress) { $opBuild.data.routerAddress } else { $opQuote.data.routerAddress })
if ([int]$opBuild.code -ne 0 -or $opKyberTarget -ine $opKyberAddress -or $opBuild.data.data -notmatch '^0x[0-9a-fA-F]{8,}$') {
    throw 'Kyber build failed canonical target/calldata checks.'
}
if ($opBuild.data.transactionValue -and [bigint]$opBuild.data.transactionValue -ne 0) { throw 'Native-value Kyber payload is unsupported.' }
$opKyberAmountOut = [bigint]$(if ($opBuild.data.amountOut) { $opBuild.data.amountOut } else { $opQuote.data.routeSummary.amountOut })
if ($opKyberAmountOut -le 0) { throw 'Kyber build returned no output.' }

$opSlippage = ($SlippageBps / 10000).ToString([Globalization.CultureInfo]::InvariantCulture)
$opLifiUrl = "https://li.quest/v1/quote?fromChain=10&toChain=10&fromToken=$opWeth&toToken=$opUsdc&fromAmount=$opAmount&fromAddress=$TakerAddress&toAddress=$TakerAddress&slippage=$opSlippage"
$opLifi = Invoke-RestMethod -Uri $opLifiUrl -Headers @{ Accept = 'application/json' } -TimeoutSec 30
if ($opLifi.action.fromChainId -ne 10 -or $opLifi.action.toChainId -ne 10 -or $opLifi.transactionRequest.chainId -ne 10) {
    throw 'LI.FI payload must remain on chain 10.'
}
if ($opLifi.estimate.approvalAddress -ine $opLifiAddress -or $opLifi.transactionRequest.to -ine $opLifiAddress -or $opLifi.transactionRequest.data -notmatch '^0x[0-9a-fA-F]{8,}$') {
    throw 'LI.FI build failed canonical target/spender/calldata checks.'
}
if ($opLifi.transactionRequest.value -and [bigint]$opLifi.transactionRequest.value -ne 0) { throw 'Native-value LI.FI payload is unsupported.' }
$opLifiAmountOut = [bigint]$opLifi.estimate.toAmount
if ($opLifiAmountOut -le 0) { throw 'LI.FI build returned no output.' }

$opFixture = @{
    taker = $TakerAddress
    forkBlock = [long]"$opBlock".Trim()
    kyber = @{
        target = $opKyberAddress; spender = $opKyberAddress; data = $opBuild.data.data
        minimum = ($opKyberAmountOut * (10000 - $SlippageBps) / 10000).ToString()
    }
    lifi = @{
        target = $opLifiAddress; spender = $opLifiAddress; data = $opLifi.transactionRequest.data
        minimum = ($opLifiAmountOut * (10000 - $SlippageBps) / 10000).ToString()
    }
}
$opOutputPath = Join-Path $opContractRoot 'out'
New-Item -ItemType Directory -Path $opOutputPath -Force | Out-Null
$opFixtureFile = $(if ($opDeployed) { 'optimism-deployed-aggregator-fixture.json' } else { 'optimism-aggregator-fork-fixture.json' })
$opFixture | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $opOutputPath $opFixtureFile)
Write-Output "Built canonical Kyber/LI.FI payloads for taker $TakerAddress at OP block $opBlock."
Write-Output "API USDC estimates: Kyber $opKyberAmountOut; LI.FI $opLifiAmountOut."

$opPreviousEnv = @{}
$opTestEnv = @{
    DUST_SWEEP_OPTIMISM_FORK_TESTS = '1'
    DUST_SWEEP_OPTIMISM_AGGREGATOR_FORK_TESTS = '1'
    OPTIMISM_MAINNET_RPC_URL = $RpcUrl
    OPTIMISM_FORK_BLOCK = "$opBlock".Trim()
}
if ($opDeployed) {
    $opTestEnv.DUST_SWEEP_OPTIMISM_DEPLOYED_FORK_TESTS = '1'
    $opTestEnv.DUST_SWEEP_OPTIMISM_DEPLOYED_AGGREGATOR_FORK_TESTS = '1'
}
foreach ($opName in $opTestEnv.Keys) {
    $opPreviousEnv[$opName] = [Environment]::GetEnvironmentVariable($opName, 'Process')
    [Environment]::SetEnvironmentVariable($opName, $opTestEnv[$opName], 'Process')
}
Push-Location $opContractRoot
try {
    $opTestContract = $(if ($opDeployed) { 'DustSwapSweepRouterOptimismDeployedForkTest' } else { 'DustSwapSweepRouterOptimismForkTest' })
    $opTestPattern = $(if ($opDeployed) { 'testDeployedAggregator(Kyber|Lifi)' } else { 'testForkAggregator(KyberBuiltPayload|LifiBuiltPayload)' })
    $opRequiredTests = $(if ($opDeployed) { @('testDeployedAggregatorKyber', 'testDeployedAggregatorLifi') } else { @('testForkAggregatorKyberBuiltPayload', 'testForkAggregatorLifiBuiltPayload') })
    $opForkOutput = & forge test --match-contract $opTestContract --match-test $opTestPattern --evm-version cancun -vv
    $opForkExit = $LASTEXITCODE
    $opForkOutput | Write-Output
    if ($opForkExit -ne 0) {
        throw 'Both aggregator payload fork tests must execute successfully. Missing or skipped tests do not pass this release check.'
    }
    foreach ($opRequiredTest in $opRequiredTests) {
        if (!($opForkOutput -match ("\[PASS\] " + [regex]::Escape($opRequiredTest) + '\(\)'))) {
            throw 'Both aggregator payload fork tests must execute successfully. Missing or skipped tests do not pass this release check.'
        }
    }
} finally {
    Pop-Location
    foreach ($opName in $opTestEnv.Keys) {
        [Environment]::SetEnvironmentVariable($opName, $opPreviousEnv[$opName], 'Process')
    }
}
