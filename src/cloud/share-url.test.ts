import { afterEach, describe, expect, it } from 'vitest';
import { shareUrlFor } from './share';

// The share link must live NEXT TO the app, wherever the host mounts it:
// a root deploy serves /share/?t=…, a subpath deploy (alwaysdata-style
// shared domains) serves /padify/share/?t=…. Building it from the origin
// instead of the document is the regression these pin out.

const navigate = (path: string): void => {
  window.history.replaceState(null, '', path);
};

describe('shareUrlFor', () => {
  afterEach(() => {
    navigate('/');
  });

  it('links the viewer next to the app at the domain root', () => {
    navigate('/index.html');

    expect(shareUrlFor('abc123')).toBe(`${window.location.origin}/share/?t=abc123`);
  });

  it('keeps subpath deployments inside the subpath', () => {
    navigate('/padify/index.html');

    expect(shareUrlFor('tok')).toBe(`${window.location.origin}/padify/share/?t=tok`);
  });

  it('resolves from a directory URL without index.html', () => {
    navigate('/padify/');

    expect(shareUrlFor('t')).toBe(`${window.location.origin}/padify/share/?t=t`);
  });

  it('drops the query the page URL carries so links stay clean', () => {
    navigate('/?utm=campaign');

    expect(shareUrlFor('t1')).toBe(`${window.location.origin}/share/?t=t1`);
  });

  it('encodes the token so it cannot smuggle extra parameters', () => {
    navigate('/');

    expect(shareUrlFor('a b&c=d')).toBe(`${window.location.origin}/share/?t=a+b%26c%3Dd`);
  });
});
