export class BudgetExceeded extends Error {
  readonly code = "budget_exceeded";
  constructor(
    readonly scopes: string[],
    readonly estMicros: number,
  ) {
    super(`Spending limit reached (${scopes.join(", ")})`);
    this.name = "BudgetExceeded";
  }
}
