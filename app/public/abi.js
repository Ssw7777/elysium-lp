(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LPAbi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const erc20 = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ];
  const stateView = [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
    'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
    'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
    'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
    'function getTickBitmap(bytes32 poolId, int16 wordPos) view returns (uint256 bitmap)',
    'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
    'function poolManager() view returns (address)'
  ];
  const positionManager = [
    'function balanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
    'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
    'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
    'function modifyLiquiditiesWithoutUnlock(bytes actions, bytes[] params) payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed id)'
  ];
  const permit2 = [
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
    'function approve(address token, address spender, uint160 amount, uint48 expiration)'
  ];
  return { erc20, stateView, positionManager, permit2 };
});
