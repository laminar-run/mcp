/**
 * Shared mutable session state for VM and Browser RPA connections.
 * Imported by tool modules that need to read/write connection state.
 */

import type * as lds from "./lds-client.js";

export interface LdsConnection {
  url: string;
  apiKey?: string;
  serviceId?: string;
}

export interface BrowserConnection {
  baseUrl: string;
  bearerToken: string;
  slackChannelId?: string;
  sessionId?: string;
}

export let ldsConnection: LdsConnection | null = null;
export let browserConnection: BrowserConnection | null = null;

export function setLdsConnection(conn: LdsConnection | null) {
  ldsConnection = conn;
}

export function setBrowserConnection(conn: BrowserConnection | null) {
  browserConnection = conn;
}

export function updateBrowserSession(sessionId: string | undefined) {
  if (browserConnection) {
    browserConnection.sessionId = sessionId;
  }
}

export function ldsAuth(): lds.LdsAuth | undefined {
  if (ldsConnection?.apiKey && ldsConnection?.serviceId) {
    return { apiKey: ldsConnection.apiKey, serviceId: ldsConnection.serviceId };
  }
  return undefined;
}
