// expect(query).rejects nunca dispara a query lazy do Bun.SQL (Bun 1.4) e trava o teste.
export async function failure(statement: PromiseLike<unknown>): Promise<unknown> {
  try {
    await statement;
  } catch (error) {
    return error;
  }
  throw new Error('expected the statement to fail');
}
