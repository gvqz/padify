import { describe, expect, it } from 'vitest';
import { pathPrefixFromEnv, stripPathPrefix } from '../server/http';

// Shared-domain deployments (alwaysdata sites, the reference) mount the API
// at a subpath and proxy the FULL original path to the process — the router
// speaks plain /api/…, so the mount prefix has to come off first. These pin
// the stripping rules and the env normalization that feeds them.

describe('stripPathPrefix', () => {
  it('leaves root deployments untouched', () => {
    expect(stripPathPrefix('/api/health', '')).toBe('/api/health');
    expect(stripPathPrefix('/api/health', '/')).toBe('/api/health');
  });

  it('strips the mount prefix off matching paths', () => {
    expect(stripPathPrefix('/padifyapi/api/health', '/padifyapi')).toBe('/api/health');
    expect(stripPathPrefix('/padifyapi/api/notes', '/padifyapi/')).toBe('/api/notes');
  });

  it('maps the bare mount to the root path', () => {
    expect(stripPathPrefix('/padifyapi', '/padifyapi')).toBe('/');
  });

  it('never strips a partial prefix — only whole segments', () => {
    expect(stripPathPrefix('/padify/api/health', '/padifyapi')).toBe('/padify/api/health');
    expect(stripPathPrefix('/api/health', '/padifyapi')).toBe('/api/health');
  });
});

describe('pathPrefixFromEnv', () => {
  it('normalizes the usual spellings to one form', () => {
    expect(pathPrefixFromEnv('/padifyapi/')).toBe('/padifyapi');
    expect(pathPrefixFromEnv('/padifyapi')).toBe('/padifyapi');
    expect(pathPrefixFromEnv('  /padifyapi  ')).toBe('/padifyapi');
  });

  it('treats unset, empty and slash-only as a root deployment', () => {
    expect(pathPrefixFromEnv(undefined)).toBe('');
    expect(pathPrefixFromEnv('')).toBe('');
    expect(pathPrefixFromEnv('/')).toBe('');
    expect(pathPrefixFromEnv('///')).toBe('');
  });
});
