import { describe, expect, it } from "vitest";
import { calculateHealthFactor, type RiskExposure } from "./health-factor";

const exposure = (overrides: Partial<RiskExposure> = {}): RiskExposure => ({
  tokenId: "wnear.testnet",
  kind: "collateral",
  balanceRaw: "1000",
  extraDecimals: 0,
  priceMultiplier: "7",
  priceDecimals: 0,
  volatilityRatio: "5000",
  quoteUnit: "USD",
  ...overrides,
});

describe("calculateHealthFactor", () => {
  it("reproduces the documented 87.5% weighted collateral-to-debt example exactly", () => {
    const result = calculateHealthFactor([
      exposure(),
      exposure({
        tokenId: "stable.testnet",
        kind: "borrowed",
        balanceRaw: "4000",
        priceMultiplier: "1",
        volatilityRatio: "10000",
      }),
    ]);

    expect(result).toMatchObject({
      status: "calculated-unverified-model",
      healthFactorPercent: { numerator: "175", denominator: "2" },
      healthFactorBasisPoints: "8750",
      riskClassification: null,
      verification: "not-matched-to-deployed-testnet-contract",
    });
  });

  it("applies token extra decimals and price decimals without floating point", () => {
    const result = calculateHealthFactor([
      exposure({
        balanceRaw: "1000000",
        extraDecimals: 3,
        priceMultiplier: "125",
        priceDecimals: 2,
      }),
      exposure({
        tokenId: "debt.testnet",
        kind: "borrowed",
        balanceRaw: "1000",
        priceMultiplier: "1",
        volatilityRatio: "10000",
      }),
    ]);

    expect(result).toMatchObject({
      status: "calculated-unverified-model",
      healthFactorPercent: { numerator: "125", denominator: "2" },
      healthFactorBasisPoints: "6250",
    });
  });

  it("keeps the RHEA SDK maximum ratio cap", () => {
    const result = calculateHealthFactor([
      exposure({ balanceRaw: "1000000" }),
      exposure({
        kind: "borrowed",
        tokenId: "debt.testnet",
        balanceRaw: "1",
        priceMultiplier: "1",
        volatilityRatio: "10000",
      }),
    ]);

    expect(result).toMatchObject({
      status: "calculated-unverified-model",
      healthFactorPercent: { numerator: "10000", denominator: "1" },
      healthFactorBasisPoints: "1000000",
    });
  });

  it("does not classify a result as liquidation risk before deployment validation", () => {
    const result = calculateHealthFactor([
      exposure(),
      exposure({
        kind: "borrowed",
        tokenId: "debt.testnet",
        balanceRaw: "4000",
        priceMultiplier: "1",
        volatilityRatio: "10000",
      }),
    ]);

    expect(result.status).toBe("calculated-unverified-model");
    expect(result.riskClassification).toBeNull();
    if (result.status === "calculated-unverified-model") {
      expect(result.reason).toContain("deployed testnet contract equivalence");
    }
  });

  it("reports no debt without fabricating an infinite health factor", () => {
    expect(calculateHealthFactor([exposure()])).toMatchObject({
      status: "no-debt",
      healthFactorPercent: null,
      healthFactorBasisPoints: null,
      riskClassification: null,
    });
  });

  it("returns zero health factor when positive debt has no collateral", () => {
    expect(
      calculateHealthFactor([
        exposure({ balanceRaw: "0" }),
        exposure({ kind: "borrowed", tokenId: "debt.testnet", balanceRaw: "1000" }),
      ]),
    ).toMatchObject({
      status: "calculated-unverified-model",
      healthFactorPercent: { numerator: "0", denominator: "1" },
      healthFactorBasisPoints: "0",
      riskClassification: null,
    });
  });

  it("rejects negative and malformed values, including null exposures", () => {
    expect(calculateHealthFactor([exposure({ balanceRaw: "-1" })])).toMatchObject({
      status: "unavailable",
      reasonCode: "INVALID_EXPOSURE",
    });
    expect(calculateHealthFactor([exposure({ priceMultiplier: "-1" })])).toMatchObject({
      status: "unavailable",
      reasonCode: "MISSING_OR_INVALID_PRICE",
    });
    expect(calculateHealthFactor([null as unknown as RiskExposure])).toMatchObject({
      status: "unavailable",
      reasonCode: "INVALID_EXPOSURE",
    });
    expect(
      calculateHealthFactor([
        exposure({
          kind: "borrowed",
          tokenId: "debt.testnet",
          balanceRaw: "1000",
          priceMultiplier: "1",
          volatilityRatio: "10000",
          extraDecimals: -1,
        }),
      ]),
    ).toMatchObject({ status: "unavailable", reasonCode: "INVALID_EXPOSURE" });
  });

  it("fails closed when a volatility ratio is zero or missing", () => {
    expect(calculateHealthFactor([exposure({ volatilityRatio: "0" })])).toMatchObject({
      status: "unavailable",
      reasonCode: "MISSING_VOLATILITY_RATIO",
    });
    expect(
      calculateHealthFactor([exposure({ volatilityRatio: undefined as unknown as string })]),
    ).toMatchObject({ status: "unavailable", reasonCode: "MISSING_VOLATILITY_RATIO" });
  });

  it("fails closed for absent or inconsistent price units", () => {
    expect(calculateHealthFactor([exposure({ priceMultiplier: "0" })])).toMatchObject({
      status: "unavailable",
      reasonCode: "MISSING_OR_INVALID_PRICE",
    });
    expect(
      calculateHealthFactor([
        exposure(),
        exposure({ kind: "borrowed", tokenId: "debt.testnet", quoteUnit: "NEAR" }),
      ]),
    ).toMatchObject({ status: "unavailable", reasonCode: "INCONSISTENT_QUOTE_UNIT" });
  });

  it("rejects malformed integer strings and decimal scales", () => {
    expect(calculateHealthFactor([exposure({ balanceRaw: "1.25" })])).toMatchObject({
      status: "unavailable",
      reasonCode: "INVALID_EXPOSURE",
    });
    expect(calculateHealthFactor([exposure({ priceDecimals: 81 })])).toMatchObject({
      status: "unavailable",
      reasonCode: "INVALID_EXPOSURE",
    });
  });

  it("distinguishes missing position data from a zero-valued position", () => {
    expect(calculateHealthFactor([])).toMatchObject({
      status: "unavailable",
      reasonCode: "NO_EXPOSURES",
    });
  });
});
