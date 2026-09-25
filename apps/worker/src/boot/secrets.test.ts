import { describe, expect, it } from "vitest";
import { envNameFor, parseLoginSecret } from "./secrets.ts";

describe("envNameFor", () => {
  it("maps vault purposes to env names", () => {
    expect(envNameFor("upload_post.api_key")).toBe("UPLOAD_POST_API_KEY");
    expect(envNameFor("elevenlabs.api_key")).toBe("ELEVENLABS_API_KEY");
  });
});

describe("parseLoginSecret", () => {
  it("accepts a username and password", () => {
    expect(parseLoginSecret('{"username":"demo","password":"pw"}')).toEqual({ username: "demo", password: "pw" });
  });
  it("keeps a relative login path only", () => {
    expect(parseLoginSecret('{"username":"a","password":"b","loginPath":"/signin"}')?.loginPath).toBe("/signin");
    expect(parseLoginSecret('{"username":"a","password":"b","loginPath":"https://x"}')?.loginPath).toBeUndefined();
  });
  it("rejects missing or malformed values", () => {
    expect(parseLoginSecret(null)).toBeNull();
    expect(parseLoginSecret("not json")).toBeNull();
    expect(parseLoginSecret('{"username":"a"}')).toBeNull();
  });
});
