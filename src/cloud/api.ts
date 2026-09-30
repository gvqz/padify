/**
 * Padify cloud — shared fetch wrapper for the padify API (see server/).
 *
 * Attaches the bearer session token, parses JSON errors into ApiError, and
 * translates network failures into a stable, recognisable message shape.
 */

import { getCloudConfig } from './config';
import { stateGet } from '../storage';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
}

/**
 * Fetch for non-JSON traffic (attachments: raw-byte uploads, binary
 * downloads). Same bearer + error translation as api(), but the caller
 * owns the headers and gets the bare Response to read as bytes.
 */
export async function apiRaw(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: ArrayBuffer;
  } = {},
): Promise<Response> {
  const headers = { ...options.headers };
  const token = readSessionToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  try {
    return await fetch(`${getCloudConfig().apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
    });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const token = readSessionToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${getCloudConfig().apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof data.error === 'string' ? data.error : `Request failed (${response.status})`,
    );
  }
  return data as T;
}

/**
 * Reads the session token straight from the storage layer so that any module
 * can call the API without importing the sync engine (and its side effects).
 */
function readSessionToken(): string | null {
  try {
    const raw = stateGet('padifySession');
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { token?: unknown } | null;
    return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}
