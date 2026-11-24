import { describe, expect, it } from "vitest";
import { describeRemoteFailure } from "../remote-failure";

const M = "devbox-vps";

describe("telling an operator why a machine did not answer", () => {
  it("turns the control-socket timeout into one sentence and one command", () => {
    const failure = describeRemoteFailure(
      new Error(
        "SSH master did not create control socket within 8 s (target: alwi@devbox-vps). The host may be unreachable or authentication failed.",
      ),
      M,
    );
    expect(failure.title).toBe("devbox-vps did not answer in time");
    expect(failure.action).toMatch(/ssh devbox-vps/);
    expect(failure.action).toMatch(/Cloudflare Access/);
  });

  it("never puts our internals in the headline", () => {
    const failure = describeRemoteFailure(new Error("SSH master did not create control socket"), M);
    expect(failure.title).not.toMatch(/control socket|SSH master/i);
    expect(failure.detail).toMatch(/control socket/);
  });

  it("reads a refused key as a key problem, not a dead host", () => {
    const failure = describeRemoteFailure("Permission denied (publickey).", M);
    expect(failure.title).toMatch(/rejected the key/);
    expect(failure.action).toMatch(/ssh-copy-id/);
  });

  it("recognises an unknown host fingerprint", () => {
    const failure = describeRemoteFailure("Host key verification failed.", M);
    expect(failure.title).toMatch(/fingerprint/);
  });

  it("passes our own directory sentence through, because it is already actionable", () => {
    const failure = describeRemoteFailure(
      "Cannot open /root/secret on this machine — it does not exist, or you do not have permission.",
      M,
    );
    expect(failure.title).toBe("That folder could not be opened");
    expect(failure.action).toMatch(/Go up one level/);
  });

  it("keeps an unfamiliar message as the headline rather than flattening it", () => {
    const failure = describeRemoteFailure("kex_exchange_identification: banner line contains junk", M);
    expect(failure.detail).toMatch(/kex_exchange_identification/);
    expect(failure.action).toBeTruthy();
  });

  it("survives a non-Error being thrown at it", () => {
    expect(describeRemoteFailure(undefined, M).detail).toBe("No details available.");
    expect(describeRemoteFailure({ nope: 1 }, M).title).toMatch(/Could not read the folder/);
  });
});
