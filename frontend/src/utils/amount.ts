export const USDC_DECIMALS = 6;

export function parseUsdToBaseUnits(input: string): bigint {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Amount is required");
  }

  if (!/^\d+(\.\d{0,6})?$/.test(normalized)) {
    throw new Error("Amount must be a positive number with up to 6 decimals");
  }

  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "000000").slice(0, USDC_DECIMALS);
  return BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(fractionPadded);
}

export function formatBaseUnits(amount: bigint | string, decimals = USDC_DECIMALS): string {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
}


