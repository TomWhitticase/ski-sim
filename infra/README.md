# Resort data hosting (Cloudflare, free tier only)

The site (GitHub Pages) loads resort data from `https://ski-sim-data.tom-pe-wh.workers.dev/`:
a Worker (`data-worker/`) in front of a private R2 bucket, `ski-sim-data`. Everything
here is code: `setup.sh` creates or repairs it, `scripts/publish-data.sh` uploads.

## Why it can't cost money

| Charge | Free allowance | What keeps us under it |
|---|---|---|
| Worker requests | 100,000 a day on the Workers **Free** plan | Hard cap: past it the Worker returns error 1027 until midnight UTC. Free plans aren't billed for usage. |
| R2 reads (Class B) | 10 M a month | The bucket has no public URL (r2.dev off, no custom domain), so every read goes through the Worker: at most 1 read per request, so at most ~3 M a month. Anything that isn't a plain file path is refused before the bucket is touched. |
| R2 storage | 10 GB a month | `publish-data.sh` refuses if the bucket plus the upload could pass 9 GB. |
| R2 uploads (Class A) | 1 M a month | Only `publish-data.sh` writes (your wrangler login; the Worker is read-only). It refuses more than 20,000 files in one go; a full publish is ~1,000. |
| Egress (bandwidth) | unlimited | R2 never charges for it. |

What that relies on, so check after changing anything on the account:
- **The Workers plan stays Free** (dashboard → Compute → Workers plans: "Current plan"). On
  Workers Paid the 100,000/day cap becomes billable usage. `setup.sh` won't run without
  `--free-plan-checked`.
- **The bucket stays private.** `setup.sh` switches the r2.dev URL off and refuses to deploy
  if it's on or a custom domain is attached.
- **Nothing else reads the bucket.** No other Worker or token should be bound to it.

The billing budget alert (dashboard → Alerts → Platform Notifications) emails you if any
spend appears; it doesn't stop spending, it's the alarm if one of the above slips.

The cost of the cap: about 5,000 resort loads a day (~20 files each). Past that, players
get errors until the next day.

## Commands

```sh
infra/setup.sh --free-plan-checked     # bucket (private) + Worker; safe to re-run
scripts/publish-data.sh <ids…>         # upload resorts (needs the DATA_BUCKET repo variable)
gh variable set DATA_BUCKET --body ski-sim-data
gh variable set DATA_URL --body https://ski-sim-data.tom-pe-wh.workers.dev/   # site reads R2
```

Set `DATA_URL` only once the bucket holds the resorts: the next deploy reads from it.
