# Read-only OP Mainnet preflight. Requires Foundry cast; never signs or broadcasts.
# Run from any directory:
#   ./VerifyOptimismDependencies.ps1
#   ./VerifyOptimismDependencies.ps1 -RouterAddress 0xYourDeployedRouter
param(
    [string]$RpcUrl = $(if ($env:OPTIMISM_MAINNET_RPC_URL) { $env:OPTIMISM_MAINNET_RPC_URL } else { 'https://mainnet.optimism.io' }),
    [string]$RouterAddress = $env:DUST_SWEEP_ROUTER_V3_ADDRESS_10
)

$ErrorActionPreference = 'Stop'

function Invoke-OpCast {
    param([string[]]$CastArgs)
    $result = & cast @CastArgs --rpc-url $RpcUrl
    if ($LASTEXITCODE -ne 0) { throw 'Read-only Optimism RPC check failed.' }
    return ($result -join "`n").Trim()
}

function Assert-OpValue {
    param([string]$Actual, [string]$Expected, [string]$Label)
    if ($Actual.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) {
        throw "$Label mismatch: expected $Expected, received $Actual"
    }
    Write-Output "$Label OK: $Actual"
}

$opWeth = '0x4200000000000000000000000000000000000006'
$opPermit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
$opUsdc = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
$opV3Factory = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
$opV2Factory = '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf'
$opVeloFactory = '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a'
$opTargets = [ordered]@{
    UniswapV3 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    UniswapV2 = '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2'
    VelodromeV2 = '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858'
    Kyber = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
    Lifi = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
}
$opDependencies = [ordered]@{
    WETH = $opWeth
    Permit2 = $opPermit2
    USDC = $opUsdc
    Multicall3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
    UniswapV3Factory = $opV3Factory
    UniswapV3Quoter = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
    UniswapV2Factory = $opV2Factory
    VelodromeV2Factory = $opVeloFactory
}
foreach ($entry in $opTargets.GetEnumerator()) { $opDependencies.Add($entry.Key, $entry.Value) }
if ($RouterAddress) {
    if ($RouterAddress -notmatch '^0x[0-9a-fA-F]{40}$' -or $RouterAddress -match '^0x0{40}$') {
        throw 'RouterAddress must be a nonzero 20-byte hex address.'
    }
    $opDependencies.Add('DustSwapSweepRouterOptimism', $RouterAddress)
}

Assert-OpValue (Invoke-OpCast -CastArgs @('chain-id')) '10' 'Chain ID'
Write-Output "Read-only checks at OP Mainnet block $(Invoke-OpCast -CastArgs @('block-number'))"
foreach ($entry in $opDependencies.GetEnumerator()) {
    $code = Invoke-OpCast -CastArgs @('code', $entry.Value)
    if ($code -notmatch '^0x[0-9a-fA-F]+$' -or $code.Length -le 2) {
        throw "No deployed contract code for $($entry.Key) at $($entry.Value)"
    }
    Write-Output "$($entry.Key) code OK: $([int](($code.Length - 2) / 2)) bytes"
}

Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opWeth, 'decimals()(uint8)')) '18' 'WETH decimals'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opUsdc, 'decimals()(uint8)')) '6' 'Native USDC decimals'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opTargets.UniswapV3, 'factory()(address)')) $opV3Factory 'V3 router factory'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opTargets.UniswapV3, 'WETH9()(address)')) $opWeth 'V3 router WETH'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opTargets.UniswapV2, 'factory()(address)')) $opV2Factory 'V2 router factory'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opTargets.VelodromeV2, 'defaultFactory()(address)')) $opVeloFactory 'Velodrome factory'
Assert-OpValue (Invoke-OpCast -CastArgs @('call', $opTargets.VelodromeV2, 'weth()(address)')) $opWeth 'Velodrome WETH'

if ($RouterAddress) {
    Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'permit2()(address)')) $opPermit2 'Sweep router Permit2'
    Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'weth()(address)')) $opWeth 'Sweep router WETH'
    Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'feeBps()(uint16)')) '200' 'Sweep router default fee'
    Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'paused()(bool)')) 'false' 'Sweep router unpaused'
    Write-Output "Sweep router owner: $(Invoke-OpCast -CastArgs @('call', $RouterAddress, 'owner()(address)'))"
    Write-Output "Sweep router collector: $(Invoke-OpCast -CastArgs @('call', $RouterAddress, 'feeCollector()(address)'))"
    foreach ($entry in $opTargets.GetEnumerator()) {
        Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'allowedTargets(address)(bool)', $entry.Value)) 'true' "$($entry.Key) target allowlist"
        Assert-OpValue (Invoke-OpCast -CastArgs @('call', $RouterAddress, 'allowedSpenders(address)(bool)', $entry.Value)) 'true' "$($entry.Key) spender allowlist"
    }
}
Write-Output 'Read-only dependency preflight passed. Run the fork suite and application smoke checks before enabling chain 10.'
