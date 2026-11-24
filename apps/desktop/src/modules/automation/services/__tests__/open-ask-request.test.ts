import { describe, expect, it } from "vitest";

import { clearOpenAskRequest, openAskRequest, requestOpenAsk, subscribeToOpenAskRequest } from "../open-ask-request";

describe("open-ask-request", () => {
  it("hands the shell each request to open an Ask, numbered so the same Ask twice still counts", () => {
    let heard = 0;
    const off = subscribeToOpenAskRequest(() => heard++);
    requestOpenAsk("ask1");
    const first = openAskRequest();
    requestOpenAsk("ask1");
    expect(openAskRequest()?.id).toBe("ask1");
    expect(openAskRequest()!.seq).toBeGreaterThan(first!.seq);
    expect(heard).toBe(2);
    clearOpenAskRequest();
    expect(openAskRequest()).toBeNull();
    off();
    requestOpenAsk("ask2");
    expect(heard).toBe(3);
  });
});
