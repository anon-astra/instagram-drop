# High-resolution experiment — not production

Branch: `experiment/high-res`. The live Drop resolver, B2 collection, and GitHub Pages configuration are unchanged. This is a local, read-only diagnostic, not a deployed preview site.

## Question

For `Ddx29K6DbbQ`, can Instagram return the same higher-resolution image exposed by the desktop browser? The supplied URL contains `3072` in encoded metadata, but that alone does not establish the downloaded image dimensions or original-upload quality.

## Run

Requires Python 3.10+; no packages to install. Download this folder or check out this branch, then run from this folder:

```sh
python highres_probe.py Ddx29K6DbbQ --verify
```

On some machines the command is `python3` or `py`. Enter your Instagram `sessionid` at the hidden terminal prompt. Do not put it in a command, GitHub secret, screenshot, chat, or committed file. The program keeps it in memory only and does not read existing browser cookies.

The experiment makes three bounded probes, with no automatic retries:

1. Existing mobile media-info endpoint and user agent (Drop baseline).
2. Same endpoint with a desktop browser user agent (an experiment, not proof of desktop parity).
3. The desktop post page's embedded JSON, restricted to the requested post.

It compares image candidates by carousel item and media ID. It excludes video thumbnails, unrelated posts, and non-Instagram CDN addresses. URLs are used exactly as supplied by Instagram; no dimension/query rewriting, upscaling, GraphQL document-ID guessing, challenge bypass, or session forwarding to CDN hosts.

`--verify` downloads at most the top advertised image per source/item into memory (40 MB each), then reads actual JPEG/PNG dimensions. It does not save the media. WebP/AVIF verification is explicitly reported as unsupported. More pixels do not by themselves prove less compression or that the file is the original upload.

## If desktop HTML does not contain the candidate

Modern Instagram may fetch images through a separate web API after the page loads. In desktop Developer Tools → Network, locate the JSON response containing that post's `image_versions2` or `display_resources`. Save **only the response JSON** locally, not a HAR or Copy-as-cURL request (those can contain cookies). Then:

```sh
python highres_probe.py Ddx29K6DbbQ --web-json desktop-response.json --verify
```

Keep that response file private and outside the repository; it can contain private metadata and signed URLs. Matching is by the requested post's shortcode/media ID, not arbitrary images found anywhere in the response.

## Read the result

Compare the `actual` pixel dimensions for the **same media ID/item** between `mobile-baseline` and desktop sources. A verified desktop 3072-pixel image versus a smaller baseline supports adding that source to Drop. Equal sizes or missing candidates are inconclusive about other web API responses. The desktop response capture can demonstrate availability, but does not yet automate retrieving that response.

401/403/429 stop further Instagram metadata probes. A sign-in/challenge page or unsupported response produces no matching candidates; do not repeatedly retry or evade the restriction. CDN URLs can expire independently.

The report contains dimensions and media IDs, not signed URLs or session credentials. No B2 calls, production writes, downloads to disk, or changes to saved posts are made.

## Tests and current status

```sh
python -m unittest -v test_highres.py
```

Synthetic tests cover candidate identity, carousel order, CDN host boundaries, untouched URLs, JSON parsing and JPEG/PNG dimensions. Authenticated testing on the example post remains pending: no user's Instagram session is available to the development environment. Do not claim 3072-pixel support until the live comparison confirms it.
