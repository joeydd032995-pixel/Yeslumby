import { describe, it, expect } from "vitest";
import { isTransactionPooler } from "../src/client.js";

/**
 * The consequence of getting this wrong is a query that fails only under
 * concurrency, only in production, so the detection is worth pinning down.
 */
describe("isTransactionPooler", () => {
  it("recognizes a transaction pooler by port", () => {
    expect(
      isTransactionPooler("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"),
    ).toBe(true);
  });

  it("recognizes the pgbouncer flag on any port", () => {
    expect(isTransactionPooler("postgresql://u:p@db.example.com:5432/postgres?pgbouncer=true")).toBe(
      true,
    );
  });

  it("treats session mode as a direct connection", () => {
    // Session mode holds one backend for the whole connection, so prepared
    // statements are safe there even though it is still a pooler.
    expect(
      isTransactionPooler("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"),
    ).toBe(false);
  });

  it("treats a local cluster as direct", () => {
    expect(isTransactionPooler("postgresql://postgres@127.0.0.1:5433/meta_ecosystem")).toBe(false);
  });

  it("does not throw on an unparseable url", () => {
    expect(isTransactionPooler("not a url")).toBe(false);
  });
});
