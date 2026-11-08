#!/usr/bin/env python3
"""Parse agent-browser eval JSON output (quoted string with escapes)."""
import json
import sys

raw = open(sys.argv[1]).read()
# agent-browser prints the eval result as a JSON-encoded string, possibly
# with a trailing status line. Try progressively.
s = raw.strip()
try:
    d = json.loads(s)
    if isinstance(d, str):
        d = json.loads(d)
except Exception:
    # strip trailing garbage: find last '}' at column 0
    idx = s.rfind('\n}')
    if idx != -1:
        s = s[: idx + 2]
    d = json.loads(s)
    if isinstance(d, str):
        d = json.loads(d)

if len(sys.argv) > 2 and sys.argv[2] == '--full':
    print(json.dumps(d, indent=1))
else:
    print('sheet w/h:', d['sheet']['w'], d['sheet']['h'])
    print('subtitle:', d['head']['subtitleText'])
    print('rows:', d['rows']['count'], 'days:', d['rows']['dayLabels'])
    for r in d['rows']['sample']:
        print(' ', r)
    print('gaps:', d['rowGaps'])
    print('footer:', d['footer']['countText'], '| del label:', d['footer']['deleteLabel'],
          '| hidden:', d['footer']['deleteHidden'], '| disabled:', d['footer']['deleteDisabled'])
