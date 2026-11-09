/*
 * Pure Uniswap V3 math used by the KNTQ/HYPE LP console.
 *
 * This file deliberately has no DOM or ethers dependency so it can be tested
 * with Node.js as well as loaded directly by the browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LPMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const Q96 = 1n << 96n;
  const Q192 = 1n << 192n;
  const MAX_UINT128 = (1n << 128n) - 1n;
  const MAX_UINT256 = (1n << 256n) - 1n;
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const MIN_SQRT_RATIO = 4295128739n;
  const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

  const TICK_MULTIPLIERS = [
    0xfffcb933bd6fad37aa2d162d1a594001n,
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n,
    0x5d6af8dedb81196699c329225ee604n,
    0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n
  ];

  function absBigInt(value) {
    return value < 0n ? -value : value;
  }

  function minBigInt() {
    let result = arguments[0];
    for (let i = 1; i < arguments.length; i += 1) {
      if (arguments[i] < result) result = arguments[i];
    }
    return result;
  }

  function maxBigInt() {
    let result = arguments[0];
    for (let i = 1; i < arguments.length; i += 1) {
      if (arguments[i] > result) result = arguments[i];
    }
    return result;
  }

  function sqrtBigInt(value) {
    if (value < 0n) throw new Error('sqrt of negative value');
    if (value < 2n) return value;
    let x0 = value;
    let x1 = (x0 + 1n) >> 1n;
    while (x1 < x0) {
      x0 = x1;
      x1 = (x1 + value / x1) >> 1n;
    }
    return x0;
  }

  /**
   * Exact port of Uniswap v3-core TickMath.getSqrtRatioAtTick.
   * @returns {bigint} sqrt(token1/token0) * 2^96
   */
  function tickToSqrtRatioX96(tick) {
    if (!Number.isInteger(tick)) throw new Error('tick must be an integer');
    if (tick < MIN_TICK || tick > MAX_TICK) throw new Error('tick out of bounds');
    const absTick = tick < 0 ? -tick : tick;
    let ratio = (absTick & 0x1) !== 0 ? TICK_MULTIPLIERS[0] : (1n << 128n);
    for (let i = 1; i < TICK_MULTIPLIERS.length; i += 1) {
      if ((absTick & (1 << i)) !== 0) {
        ratio = (ratio * TICK_MULTIPLIERS[i]) >> 128n;
      }
    }
    if (tick > 0) ratio = MAX_UINT256 / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
  }

  /** Inverse of tickToSqrtRatioX96, using the on-chain tick convention. */
  function sqrtRatioX96ToTick(sqrtRatioX96) {
    if (sqrtRatioX96 < MIN_SQRT_RATIO || sqrtRatioX96 >= MAX_SQRT_RATIO) {
      throw new Error('sqrt ratio out of bounds');
    }
    const ratio = Number(sqrtRatioX96) / Number(Q96);
    const price = ratio * ratio;
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  function priceFromSqrtX96(sqrtPriceX96) {
    // Number is only used for display. Token amounts stay in BigInt.
    const ratio = Number(sqrtPriceX96) / Number(Q96);
    return ratio * ratio;
  }

  function sqrtX96FromPrice(price) {
    const numeric = Number(price);
    if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('price must be positive');
    // Parse the decimal string rather than using Number to avoid losing precision.
    const text = String(price).trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error('unsupported price format');
    const decimals = match[2] || '';
    const numerator = BigInt(match[1] + decimals);
    const denominator = 10n ** BigInt(decimals.length);
    return sqrtBigInt((numerator * Q192) / denominator);
  }

  function tickToPrice(tick) {
    return priceFromSqrtX96(tickToSqrtRatioX96(tick));
  }

  function nearestUsableTick(tick, tickSpacing) {
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
      throw new Error('invalid tick spacing');
    }
    const rounded = Math.round(tick / tickSpacing) * tickSpacing;
    if (rounded < MIN_TICK) return rounded + tickSpacing;
    if (rounded > MAX_TICK) return rounded - tickSpacing;
    return rounded;
  }

  function alignTickDown(tick, tickSpacing) {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }

  function alignTickUp(tick, tickSpacing) {
    return Math.ceil(tick / tickSpacing) * tickSpacing;
  }

  function clampTick(tick) {
    return Math.max(MIN_TICK, Math.min(MAX_TICK, tick));
  }

  /** Align a raw tick interval inward so both ends are valid tick-spacing multiples. */
  function usableTickRange(lowerRaw, upperRaw, tickSpacing) {
    let lowerTick = alignTickDown(clampTick(lowerRaw), tickSpacing);
    let upperTick = alignTickUp(clampTick(upperRaw), tickSpacing);
    if (lowerTick < MIN_TICK) lowerTick += tickSpacing;
    if (upperTick > MAX_TICK) upperTick -= tickSpacing;
    if (lowerTick >= upperTick) throw new Error('range has no usable tick');
    return { lowerTick, upperTick };
  }

  /**
   * Convert [lowerPercent, upperPercent] around current price (e.g. -10, +10)
   * into usable ticks.  Percentages are signed relative deltas.
   */
  function rangeFromPercent(currentTick, tickSpacing, lowerPercent, upperPercent) {
    const currentPrice = tickToPrice(currentTick);
    const lowerPrice = currentPrice * (1 + lowerPercent / 100);
    const upperPrice = currentPrice * (1 + upperPercent / 100);
    if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) throw new Error('invalid range');
    const lowerRaw = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const upperRaw = Math.ceil(Math.log(upperPrice) / Math.log(1.0001));
    const ticks = usableTickRange(lowerRaw, upperRaw, tickSpacing);
    return Object.assign(ticks, { lowerPrice, upperPrice });
  }

  function rangeFromPrices(lowerPrice, upperPrice, tickSpacing) {
    if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) throw new Error('invalid range');
    const lowerRaw = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const upperRaw = Math.ceil(Math.log(upperPrice) / Math.log(1.0001));
    const ticks = usableTickRange(lowerRaw, upperRaw, tickSpacing);
    return Object.assign(ticks, { lowerPrice, upperPrice });
  }

  /** Uniswap v3 amount0 for a liquidity range, in token0 base units. */
  function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
    if (sqrtA > sqrtB) {
      const tmp = sqrtA;
      sqrtA = sqrtB;
      sqrtB = tmp;
    }
    if (sqrtA === 0n) throw new Error('sqrtA must be positive');
    return (liquidity * Q96 * (sqrtB - sqrtA)) / sqrtB / sqrtA;
  }

  /** Uniswap v3 amount1 for a liquidity range, in token1 base units. */
  function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
    if (sqrtA > sqrtB) {
      const tmp = sqrtA;
      sqrtA = sqrtB;
      sqrtB = tmp;
    }
    return (liquidity * (sqrtB - sqrtA)) / Q96;
  }

  /** Amounts for a position at the current pool price. */
  function amountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtCurrent) {
    if (liquidity < 0n) throw new Error('negative liquidity');
    if (sqrtLower > sqrtUpper) {
      const tmp = sqrtLower;
      sqrtLower = sqrtUpper;
      sqrtUpper = tmp;
    }
    if (sqrtCurrent <= sqrtLower) {
      return {
        amount0: amount0ForLiquidity(sqrtLower, sqrtUpper, liquidity),
        amount1: 0n
      };
    }
    if (sqrtCurrent >= sqrtUpper) {
      return {
        amount0: 0n,
        amount1: amount1ForLiquidity(sqrtLower, sqrtUpper, liquidity)
      };
    }
    const amount0 = (liquidity * Q96 * (sqrtUpper - sqrtCurrent)) / sqrtUpper / sqrtCurrent;
    const amount1 = (liquidity * (sqrtCurrent - sqrtLower)) / Q96;
    return { amount0, amount1 };
  }

  function liquidityForAmount0(amount0, sqrtA, sqrtB) {
    if (sqrtA > sqrtB) {
      const tmp = sqrtA;
      sqrtA = sqrtB;
      sqrtB = tmp;
    }
    if (sqrtA === 0n) throw new Error('sqrtA must be positive');
    return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA);
  }

  function liquidityForAmount1(amount1, sqrtA, sqrtB) {
    if (sqrtA > sqrtB) {
      const tmp = sqrtA;
      sqrtA = sqrtB;
      sqrtB = tmp;
    }
    return (amount1 * Q96) / (sqrtB - sqrtA);
  }

  /** Max liquidity for a token0 amount, with price below the range upper bound. */
  function liquidityForAmount0AtPrice(amount0, sqrtCurrent, sqrtUpper) {
    if (sqrtCurrent >= sqrtUpper) return 0n;
    return (amount0 * ((sqrtCurrent * sqrtUpper) / Q96)) / (sqrtUpper - sqrtCurrent);
  }

  /** Max liquidity for a token1 amount, with price above the range lower bound. */
  function liquidityForAmount1AtPrice(amount1, sqrtLower, sqrtCurrent) {
    if (sqrtCurrent <= sqrtLower) return 0n;
    return (amount1 * Q96) / (sqrtCurrent - sqrtLower);
  }

  /**
   * Given a budget denominated in token1 (native HYPE / WHYPE here), return
   * the largest liquidity whose position value at the current price does not
   * exceed the budget.  This is exact BigInt math, with a final safety trim.
   */
  function liquidityForBudget(budgetWei, sqrtLower, sqrtUpper, sqrtCurrent) {
    if (budgetWei <= 0n) return 0n;
    if (sqrtLower > sqrtUpper) {
      const tmp = sqrtLower;
      sqrtLower = sqrtUpper;
      sqrtUpper = tmp;
    }
    const probeLiquidity = 10n ** 18n;
    const probe = amountsForLiquidity(probeLiquidity, sqrtLower, sqrtUpper, sqrtCurrent);
    // Value in token1 wei: amount1 + amount0 * price.
    const probeValue = probe.amount1 + (probe.amount0 * sqrtCurrent * sqrtCurrent) / Q192;
    if (probeValue <= 0n) return 0n;
    let liquidity = (budgetWei * probeLiquidity) / probeValue;
    if (liquidity <= 0n) return 0n;
    // Trim at most a handful of times to account for integer division.
    for (let i = 0; i < 8; i += 1) {
      const amounts = amountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtCurrent);
      const value = amounts.amount1 + (amounts.amount0 * sqrtCurrent * sqrtCurrent) / Q192;
      if (value <= budgetWei) break;
      liquidity = (liquidity * 999n) / 1000n;
    }
    return liquidity;
  }

  /**
   * Budget solver when the budget is denominated in token0 (native HYPE).
   * Value per liquidity is measured in token0 wei at the current sqrt price.
   */
  function liquidityForBudgetToken0(budgetWei, sqrtLower, sqrtUpper, sqrtCurrent) {
    if (budgetWei <= 0n) return 0n;
    if (sqrtLower > sqrtUpper) {
      const tmp = sqrtLower;
      sqrtLower = sqrtUpper;
      sqrtUpper = tmp;
    }
    const probeLiquidity = 10n ** 18n;
    const probe = amountsForLiquidity(probeLiquidity, sqrtLower, sqrtUpper, sqrtCurrent);
    const probeValue = probe.amount0 + (probe.amount1 * Q192) / (sqrtCurrent * sqrtCurrent);
    if (probeValue <= 0n) return 0n;
    let liquidity = (budgetWei * probeLiquidity) / probeValue;
    for (let i = 0; i < 8; i += 1) {
      const amounts = amountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtCurrent);
      const value = amounts.amount0 + (amounts.amount1 * Q192) / (sqrtCurrent * sqrtCurrent);
      if (value <= budgetWei) break;
      liquidity = (liquidity * 999n) / 1000n;
    }
    return liquidity;
  }

  /** Ratio of token0 per token1 required by a range at the current price. */
  function token0PerToken1(sqrtLower, sqrtUpper, sqrtCurrent) {
    // Below the range the position is entirely token0; above it is entirely
    // token1.  Returning Infinity / 0 makes the budget branch explicit.
    if (sqrtCurrent <= sqrtLower) return Infinity;
    if (sqrtCurrent >= sqrtUpper) return 0;
    // Use a liquidity probe large enough that integer division does not round
    // the ratio to zero; only the ratio is returned.
    const probe = 10n ** 18n;
    const amount0 = (probe * Q96 * (sqrtUpper - sqrtCurrent)) / sqrtUpper / sqrtCurrent;
    const amount1 = (probe * (sqrtCurrent - sqrtLower)) / Q96;
    if (amount1 === 0n) return Infinity;
    return Number(amount0) / Number(amount1);
  }

  function annualizedPercent(feesNowUsd, feesPastUsd, principalUsd, elapsedSeconds) {
    if (!(principalUsd > 0) || !(elapsedSeconds > 0)) return null;
    const delta = feesNowUsd - feesPastUsd;
    if (!Number.isFinite(delta) || delta < 0) return null;
    return (delta / principalUsd) * (SECONDS_PER_YEAR / elapsedSeconds) * 100;
  }

  function perSecondUsd(feesNowUsd, feesPastUsd, elapsedSeconds) {
    if (!(elapsedSeconds > 0)) return null;
    const delta = feesNowUsd - feesPastUsd;
    if (!Number.isFinite(delta) || delta < 0) return null;
    return delta / elapsedSeconds;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return Math.round(seconds) + ' 秒';
    if (seconds < 3600) return (seconds / 60).toFixed(seconds < 600 ? 1 : 0) + ' 分钟';
    return (seconds / 3600).toFixed(1) + ' 小时';
  }

  return {
    Q96,
    Q192,
    MAX_UINT128,
    MIN_TICK,
    MAX_TICK,
    MIN_SQRT_RATIO,
    MAX_SQRT_RATIO,
    SECONDS_PER_YEAR,
    absBigInt,
    minBigInt,
    maxBigInt,
    sqrtBigInt,
    tickToSqrtRatioX96,
    sqrtRatioX96ToTick,
    priceFromSqrtX96,
    sqrtX96FromPrice,
    tickToPrice,
    nearestUsableTick,
    alignTickDown,
    alignTickUp,
    clampTick,
    usableTickRange,
    rangeFromPercent,
    rangeFromPrices,
    amount0ForLiquidity,
    amount1ForLiquidity,
    amountsForLiquidity,
    liquidityForAmount0,
    liquidityForAmount1,
    liquidityForAmount0AtPrice,
    liquidityForAmount1AtPrice,
    liquidityForBudget,
    liquidityForBudgetToken0,
    token0PerToken1,
    annualizedPercent,
    perSecondUsd,
    formatDuration
  };
});
