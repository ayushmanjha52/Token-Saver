export class PriceNotFoundError extends Error {
  override readonly name = "PriceNotFoundError";
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly tier: string,
    readonly at: Date,
  ) {
    super(
      `No ${tier} price for ${provider}/${model} effective at ${at.toISOString()}. ` +
        `Add a model_prices row covering this timestamp; the event is held in the DLQ until then.`,
    );
  }
}

export class UnpricedUsageError extends Error {
  override readonly name = "UnpricedUsageError";
  constructor(readonly units: Record<string, number>) {
    super(
      `Event includes billable units with no catalog rate: ${JSON.stringify(units)}. ` +
        `Held in the DLQ so the token cost is not recorded as the full cost.`,
    );
  }
}

export class InvalidUsageEventError extends Error {
  override readonly name = "InvalidUsageEventError";
  constructor(readonly reason: string) {
    super(`Usage event rejected: ${reason}`);
  }
}

/** A condition the code's own logic guarantees has failed; always a bug. */
export class InvariantViolationError extends Error {
  override readonly name = "InvariantViolationError";
}

export class InvalidDecimalError extends Error {
  override readonly name = "InvalidDecimalError";
  constructor(readonly value: string, readonly scale: number) {
    super(`"${value}" is not a non-negative decimal with at most ${scale} fractional digits`);
  }
}
