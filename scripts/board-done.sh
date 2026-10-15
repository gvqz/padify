#!/usr/bin/env bash
# Moves project items for the padify worktracker board: sets the Status of
# the given issue numbers to Done and archives the items.
# Usage: bash scripts/board-done.sh 130 141
set -u
cd "$(dirname "$0")/.."

TOKEN=$(git config --get remote.origin.url | sed -n 's/.*:\/\/\([^@]*\)@.*/\1/p' | cut -d: -f2)
PROJECT_ID="PVT_kwHOBxksAc4BmfP_"

gq() {
  curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/graphql" -X POST \
    -d "$1" > /tmp/gq-out.json
  cat /tmp/gq-out.json
}

# 1. The Status field id + its Done option id.
gq '{"query":"query($id:ID!){node(id:$id){... on ProjectV2{fields(first:20){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}","variables":{"id":"'$PROJECT_ID'"}}' > /tmp/fields.json
STATUS_FIELD=$(python3 -c "
import json
d=json.load(open('/tmp/fields.json'))
for f in d['data']['node']['fields']['nodes']:
    if f.get('name') == 'Status':
        print(f['id'])
        for o in f.get('options', []):
            if o['name'] == 'Done':
                print(o['id'])
")
FIELD_ID=$(echo "$STATUS_FIELD" | head -1)
DONE_ID=$(echo "$STATUS_FIELD" | tail -1)
echo "status field: ${FIELD_ID:0:30} done option: ${DONE_ID:0:30}"

for NUM in "$@"; do
  # 2. The item id for this issue number.
  gq '{"query":"query($id:ID!){node(id:$id){... on ProjectV2{items(first:60){edges{node{id content{... on Issue{number}}}}}}}}","variables":{"id":"'$PROJECT_ID'"}}' > /tmp/items.json
  ITEM_ID=$(python3 -c "
import json
d=json.load(open('/tmp/items.json'))
for e in d['data']['node']['items']['edges']:
    c = e['node'].get('content')
    if c and c.get('number') == $NUM:
        print(e['node']['id'])
        break
")
  if [ -z "$ITEM_ID" ]; then
    echo "#$NUM: no project item (created after last sync?) — skipping"
    continue
  fi
  # 3. Status → Done.
  gq '{"query":"mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){projectV2Item{id}}}","variables":{"p":"'$PROJECT_ID'","i":"'$ITEM_ID'","f":"'$FIELD_ID'","v":"'$DONE_ID'"}}' > /dev/null
  # 4. Archive (payload field is "item", not "projectV2Item" — the known quirk).
  gq '{"query":"mutation($p:ID!,$i:ID!){archiveProjectV2Item(input:{projectId:$p,itemId:$i}){item{id}}}","variables":{"p":"'$PROJECT_ID'","i":"'$ITEM_ID'"}}' > /dev/null
  echo "#$NUM: status→Done, archived"
done
