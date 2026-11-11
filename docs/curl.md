# Day 1 checks by hand (curl)

The same cases `npm run smoke` runs, as copy-paste commands. Start the server first (`npm run dev`; the
`.env` sets `DEMO_MODE=true`, which case 4 needs). Commands are bash/zsh and need only `curl`, `sed`,
`base64` and `tr`.

```bash
API=http://localhost:3000
json='Content-Type: application/json'

# Deploy the Day 1 defense. Swap "fixed" for "sliding" or "token" to check the other algorithms.
curl -s -X POST $API/api/defense -H "$json" \
  -d '{"algorithm":"fixed","maxRequests":5,"windowMs":2000,"keyBy":"user"}'

# Log in and keep the token.
TOKEN=$(curl -s -X POST $API/api/login -H "$json" -d '{"username":"alice","password":"pass-alice"}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
```

## 1. No token → 401 `missing_token`
```bash
curl -s -i $API/api/resource | sed -n '1p;$p'
# HTTP/1.1 401 Unauthorized
# {"error":"unauthorized","reason":"missing_token"}
```

## 2. Forged signature → 401 `invalid_signature`, limiter untouched
Keep alice's header and signature but swap the payload to claim `sub: "admin"`. The signature no longer matches.
```bash
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
HEADER=${TOKEN%%.*}; SIG=${TOKEN##*.}
FORGED_PAYLOAD=$(printf '{"sub":"admin","iat":%d,"exp":%d}' $(date +%s) $(( $(date +%s) + 900 )) | b64url)
curl -s $API/api/resource -H "Authorization: Bearer $HEADER.$FORGED_PAYLOAD.$SIG"
# {"error":"unauthorized","reason":"invalid_signature"}

curl -s $API/api/stats | sed -E 's/.*("trackedKeys":[0-9]+).*/\1/'
# "trackedKeys":0   ← the 401 never reached the limiter
```

## 3. `alg: none` → 401 `invalid_signature`
```bash
NONE_HEADER=$(printf '{"alg":"none","typ":"JWT"}' | b64url)
NONE_PAYLOAD=$(printf '{"sub":"alice","iat":%d,"exp":%d}' $(date +%s) $(( $(date +%s) + 900 )) | b64url)
curl -s $API/api/resource -H "Authorization: Bearer $NONE_HEADER.$NONE_PAYLOAD."
# {"error":"unauthorized","reason":"invalid_signature"}
```

## 4. Expired token → 401 `expired`
The browser can't mint a correctly signed expired token without the secret, so a demo-only endpoint issues one.
```bash
EXPIRED=$(curl -s -X POST $API/api/demo/expired-token -H "$json" -d '{"username":"alice","password":"pass-alice"}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s $API/api/resource -H "Authorization: Bearer $EXPIRED"
# {"error":"unauthorized","reason":"expired"}
```

## 5. Malformed token → 401 `malformed`
```bash
curl -s $API/api/resource -H "Authorization: Bearer a.b.c"
# {"error":"unauthorized","reason":"malformed"}
```

## 6. Valid token × 5 → 200 × 5, then 429 with `Retry-After`
Redeploy first so the earlier steps' time doesn't eat into the window.
```bash
curl -s -o /dev/null -X POST $API/api/defense -H "$json" \
  -d '{"algorithm":"fixed","maxRequests":5,"windowMs":2000,"keyBy":"user"}'
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w '%{http_code} ' $API/api/resource -H "Authorization: Bearer $TOKEN"
done; echo
# 200 200 200 200 200 429

curl -s -i $API/api/resource -H "Authorization: Bearer $TOKEN" | grep -iE '^HTTP|^retry-after|retryAfterMs'
# HTTP/1.1 429 Too Many Requests
# Retry-After: 2
# {"error":"rate_limited","retryAfterMs":1843}
```

## 7. After waiting → 200 again
```bash
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' $API/api/resource -H "Authorization: Bearer $TOKEN"
# 200
```

## 8. Algorithm-specific behaviour
Boundary timing is hard to hit by hand, so `npm run smoke` is the reliable check. Roughly:

- **Fixed:** deploy, wait ~1.7s, fire 5, wait ~0.4s, fire 5 → **10 × 200** (edge double burst).
- **Sliding:** same pattern → **5 × 200, 5 × 429**.
- **Token:** fire 5 → 200, 6th → 429, `sleep 0.4` (windowMs / maxRequests), one more → 200.

```bash
curl -s -o /dev/null -X POST $API/api/defense -H "$json" \
  -d '{"algorithm":"token","maxRequests":5,"windowMs":2000,"keyBy":"user"}'
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code} ' $API/api/resource -H "Authorization: Bearer $TOKEN"; done
sleep 0.4; curl -s -o /dev/null -w '%{http_code}\n' $API/api/resource -H "Authorization: Bearer $TOKEN"
# 200 200 200 200 200 429 200
```
