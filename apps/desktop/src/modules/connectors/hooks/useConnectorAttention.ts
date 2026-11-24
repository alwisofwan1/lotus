"use client";

import { useEffect, useState } from "react";

import { subscribeToConnectorChanges, type ConnectorsClient } from "../services/connectors-api";

/**
 * Whether a connection stopped and needs the user, for the sidebar row. Only Slack can stop on
 * its own (it gives up on a refused token); gh logins are the CLI's to lose. Failures read as
 * "fine": a badge must never throw.
 */
export function useConnectorAttention(client: ConnectorsClient): boolean {
  const [attention, setAttention] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void client
        .slackStatus()
        .then((s) => alive && setAttention(s?.state === "stopped"))
        .catch(() => alive && setAttention(false));
    read();
    const off = subscribeToConnectorChanges(read);
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return attention;
}
