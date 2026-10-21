export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Erro de programação, nunca caminho de negócio. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
