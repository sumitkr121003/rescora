/**
 * Deterministic reproduction of the health-factor algorithm in the available
 * RHEA lending SDK source. This result is deliberately not an authoritative
 * Burrow risk classification until that source is matched to the deployed
 * testnet contract and the required snapshot/oracle gates are satisfied.
 */

export type ExposureKind = "collateral" | "borrowed";

export type RiskExposure = {
  tokenId: string;
  kind: ExposureKind;
  /** Burrow's internal balance string. RHEA divides this by 10^extraDecimals. */
  balanceRaw: string;
  extraDecimals: number;
  /** Price as multiplier / 10^priceDecimals, matching RHEA's asset.price. */
  priceMultiplier: string;
  priceDecimals: number;
  /** Burrow asset config value used by the RHEA SDK; no default is assumed. */
  volatilityRatio: string;
  /** All exposures must use the same quote unit for the ratio to be meaningful. */
  quoteUnit: string;
};

export type HealthFactorResult =
  | {
      status: "calculated-unverified-model";
      healthFactorPercent: { numerator: string; denominator: string };
      /** Floors percentage × 100 for display; exact ratio remains available above. */
      healthFactorBasisPoints: string;
      riskClassification: null;
      verification: "not-matched-to-deployed-testnet-contract";
      reason: string;
    }
  | {
      status: "no-debt";
      healthFactorPercent: null;
      healthFactorBasisPoints: null;
      riskClassification: null;
      verification: "not-matched-to-deployed-testnet-contract";
      reason: string;
    }
  | {
      status: "unavailable";
      reasonCode:
        | "NO_EXPOSURES"
        | "INVALID_EXPOSURE"
        | "MISSING_OR_INVALID_PRICE"
        | "INCONSISTENT_QUOTE_UNIT"
        | "MISSING_VOLATILITY_RATIO";
      riskClassification: null;
      verification: "not-matched-to-deployed-testnet-contract";
      reason: string;
    };

type Rational = { numerator: bigint; denominator: bigint };

const MAX_RATIO = BigInt(10_000);
const MAX_EXPOSURES = 100;
const MAX_DECIMALS = 80;
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const DISPLAY_SCALE = BigInt(100);

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;

  while (b !== BigInt(0)) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a || BigInt(1);
}

function rational(numerator: bigint, denominator: bigint = BigInt(1)): Rational {
  if (denominator === BigInt(0)) throw new Error("Division by zero.");
  const sign = denominator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (numerator / divisor) * sign,
    denominator: (denominator / divisor) * sign,
  };
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left: Rational, right: Rational): Rational {
  if (right.numerator === BigInt(0)) throw new Error("Division by zero.");
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function powerOfTen(decimals: number): bigint {
  return TEN ** BigInt(decimals);
}

function isUnsignedInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function unavailable(
  reasonCode: Extract<HealthFactorResult, { status: "unavailable" }>["reasonCode"],
  reason: string,
): HealthFactorResult {
  return {
    status: "unavailable",
    reasonCode,
    riskClassification: null,
    verification: "not-matched-to-deployed-testnet-contract",
    reason,
  };
}

function adjustedValue(exposure: RiskExposure): Rational {
  const balance = rational(BigInt(exposure.balanceRaw), powerOfTen(exposure.extraDecimals));
  const price = rational(BigInt(exposure.priceMultiplier), powerOfTen(exposure.priceDecimals));
  const volatility = BigInt(exposure.volatilityRatio);
  const weighting =
    exposure.kind === "collateral"
      ? rational(volatility, MAX_RATIO)
      : rational(MAX_RATIO, volatility);

  return multiply(multiply(balance, price), weighting);
}

/**
 * Reproduces RHEA's adjusted collateral/debt ratio using explicit input data.
 * It never supplies a price, volatility ratio, risk threshold, or deployment
 * verification flag when one is missing.
 */
export function calculateHealthFactor(exposures: RiskExposure[]): HealthFactorResult {
  if (!Array.isArray(exposures) || exposures.length === 0) {
    return unavailable("NO_EXPOSURES", "No position exposures were provided.");
  }
  if (exposures.length > MAX_EXPOSURES) {
    return unavailable("INVALID_EXPOSURE", "The exposure set exceeds the supported input bound.");
  }

  const quoteUnit = exposures[0]?.quoteUnit;
  if (typeof quoteUnit !== "string" || quoteUnit.trim() === "") {
    return unavailable("INVALID_EXPOSURE", "A shared quote unit is required.");
  }

  let adjustedCollateral = rational(BigInt(0));
  let adjustedBorrowed = rational(BigInt(0));

  try {
    for (const exposure of exposures) {
      if (
        typeof exposure.tokenId !== "string" ||
        exposure.tokenId.trim() === "" ||
        (exposure.kind !== "collateral" && exposure.kind !== "borrowed") ||
        !isUnsignedInteger(exposure.balanceRaw) ||
        !Number.isInteger(exposure.extraDecimals) ||
        exposure.extraDecimals < 0 ||
        exposure.extraDecimals > MAX_DECIMALS ||
        !Number.isInteger(exposure.priceDecimals) ||
        exposure.priceDecimals < 0 ||
        exposure.priceDecimals > MAX_DECIMALS
      ) {
        return unavailable(
          "INVALID_EXPOSURE",
          "An exposure contains malformed amounts or metadata.",
        );
      }
      if (
        !isUnsignedInteger(exposure.priceMultiplier) ||
        BigInt(exposure.priceMultiplier) === BigInt(0)
      ) {
        return unavailable(
          "MISSING_OR_INVALID_PRICE",
          `A positive price is required for ${exposure.tokenId}.`,
        );
      }
      if (
        !isUnsignedInteger(exposure.volatilityRatio) ||
        BigInt(exposure.volatilityRatio) === BigInt(0)
      ) {
        return unavailable(
          "MISSING_VOLATILITY_RATIO",
          `A positive volatility ratio is required for ${exposure.tokenId}.`,
        );
      }
      if (exposure.quoteUnit !== quoteUnit) {
        return unavailable(
          "INCONSISTENT_QUOTE_UNIT",
          "All asset prices must use the same quote unit.",
        );
      }

      const value = adjustedValue(exposure);
      if (exposure.kind === "collateral") {
        adjustedCollateral = add(adjustedCollateral, value);
      } else {
        adjustedBorrowed = add(adjustedBorrowed, value);
      }
    }
  } catch {
    return unavailable("INVALID_EXPOSURE", "An exposure could not be represented exactly.");
  }

  if (adjustedBorrowed.numerator === BigInt(0)) {
    return {
      status: "no-debt",
      healthFactorPercent: null,
      healthFactorBasisPoints: null,
      riskClassification: null,
      verification: "not-matched-to-deployed-testnet-contract",
      reason: "No borrowed balance was supplied; no risk classification is made.",
    };
  }

  const uncappedPercent = multiply(divide(adjustedCollateral, adjustedBorrowed), rational(HUNDRED));
  const maximumPercent = rational(MAX_RATIO);
  const healthFactorPercent =
    uncappedPercent.numerator * maximumPercent.denominator >
    maximumPercent.numerator * uncappedPercent.denominator
      ? maximumPercent
      : uncappedPercent;
  const basisPoints = divide(
    multiply(healthFactorPercent, rational(DISPLAY_SCALE)),
    rational(BigInt(1)),
  );

  return {
    status: "calculated-unverified-model",
    healthFactorPercent: {
      numerator: healthFactorPercent.numerator.toString(),
      denominator: healthFactorPercent.denominator.toString(),
    },
    healthFactorBasisPoints: (basisPoints.numerator / basisPoints.denominator).toString(),
    riskClassification: null,
    verification: "not-matched-to-deployed-testnet-contract",
    reason:
      "This reproduces the available RHEA SDK formula; deployed testnet contract equivalence, price quality, and risk thresholds remain unverified.",
  };
}
