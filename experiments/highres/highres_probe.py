"""Read-only comparison of Instagram image candidates; Python 3.10+, no dependencies."""
import argparse
import getpass
import html.parser
import json
import re
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
MOBILE = 'Instagram 320.0.0.42.101 Android (34/14; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 557106244)'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Scripts(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.buffer = ''
        self.documents = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.active = dict(attrs).get('type') == 'application/json'
            self.buffer = ''

    def handle_data(self, data):
        if self.active:
            self.buffer += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            try:
                self.documents.append(json.loads(self.buffer))
            except ValueError:
                pass
            self.active = False


def media_id(code):
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    value = 0
    for char in code:
        value = value * 64 + alphabet.index(char)
    return str(value)


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def roots(document, code):
    expected = media_id(code)
    return [node for node in walk(document) if (
        node.get('code') == code or node.get('shortcode') == code or
        str(node.get('pk', node.get('id', ''))).split('_')[0] == expected
    ) and any(k in node for k in ('image_versions2', 'display_resources', 'carousel_media', 'edge_sidecar_to_children'))]


def candidates(document, code, source):
    output = []
    for root in roots(document, code):
        nodes = root.get('carousel_media') or [edge['node'] for edge in root.get('edge_sidecar_to_children', {}).get('edges', [])] or [root]
        for index, node in enumerate(nodes):
            if node.get('media_type') == 2 or node.get('is_video'):
                continue  # Do not mislabel a Reel thumbnail as a full image.
            images = node.get('image_versions2', {})
            versions = list(images.get('candidates') or [])
            if source != 'mobile-baseline':
                versions += list(node.get('display_resources') or [])
                versions += [v for v in walk(images.get('additional_candidates', {})) if v.get('url')]
                if node.get('display_url'):
                    versions.append({'url': node['display_url'], **(node.get('dimensions') or {})})
            for candidate in versions:
                url = candidate.get('url') or candidate.get('src')
                if not valid_cdn(url):
                    continue
                width = candidate.get('width', candidate.get('config_width', 0))
                height = candidate.get('height', candidate.get('config_height', 0))
                output.append({'item': index + 1, 'media_id': str(node.get('pk', node.get('id', ''))).split('_')[0], 'source': source, 'width': int(width or 0), 'height': int(height or 0), 'url': url})
    return output


def valid_cdn(url):
    if not isinstance(url, str):
        return False
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme == 'https' and not parsed.username and not parsed.password and parsed.port in (None, 443) and any(parsed.hostname == d or (parsed.hostname or '').endswith('.' + d) for d in ('cdninstagram.com', 'fbcdn.net'))


def request(url, ua=DESKTOP, session=None, limit=12 * 1024 * 1024):
    headers = {'User-Agent': ua, 'Accept': '*/*'}
    if session:
        if urllib.parse.urlsplit(url).hostname not in ('i.instagram.com', 'www.instagram.com'):
            raise ValueError('Refusing to send session outside Instagram.')
        headers.update({'Cookie': 'sessionid=' + session, 'X-IG-App-ID': '936619743392459', 'Referer': 'https://www.instagram.com/'})
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Response exceeded test limit.')
        return data


def image_size(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24:
        return struct.unpack('>II', data[16:24])
    if data.startswith(b'\xff\xd8'):
        pos = 2
        while pos + 4 <= len(data):
            if data[pos] != 255:
                pos += 1
                continue
            marker = data[pos + 1]
            pos += 2
            if marker in (0xD8, 0xD9) or marker == 0x00:
                continue
            length = int.from_bytes(data[pos:pos + 2], 'big')
            if length < 2:
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and pos + 7 <= len(data):
                height, width = struct.unpack('>HH', data[pos + 3:pos + 7])
                return width, height
            pos += length
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('post', help='Instagram URL or shortcode')
    parser.add_argument('--web-json', type=Path, help='Optional local desktop Network response JSON (never upload cookies/HAR)')
    parser.add_argument('--verify', action='store_true', help='Fetch top candidate per source/item and read actual JPEG/PNG dimensions (max 40 MB each)')
    args = parser.parse_args()
    match = re.fullmatch(r'(?:https://(?:www\.)?instagram\.com/(?:p|reel|tv)/)?([A-Za-z0-9_-]{1,11})/?(?:\?.*)?', args.post)
    if not match:
        parser.error('Invalid post URL or shortcode.')
    code = match[1]
    if not sys.stdin.isatty():
        parser.error('Run in an interactive terminal so the session can be entered without echo.')
    session = getpass.getpass('Instagram sessionid (hidden, held in memory only): ').strip()
    if not re.fullmatch(r'[A-Za-z0-9%:_-]{20,300}', session):
        parser.error('Invalid sessionid format.')
    results = []
    endpoint = 'https://i.instagram.com/api/v1/media/' + media_id(code) + '/info/'
    sources = [('mobile-baseline', endpoint, MOBILE), ('desktop-api', endpoint, DESKTOP), ('desktop-page', 'https://www.instagram.com/p/' + code + '/', DESKTOP)]
    for label, url, ua in sources:
        try:
            raw = request(url, ua, session)
            if label == 'desktop-page':
                scripts = Scripts()
                scripts.feed(raw.decode('utf-8', errors='replace'))
                docs = scripts.documents
            else:
                docs = [json.loads(raw)]
            found = [item for doc in docs for item in candidates(doc, code, label)]
            results += found
            print(label + ': ' + str(len(found)) + ' image candidates')
        except urllib.error.HTTPError as error:
            print(label + ': HTTP ' + str(error.code))
            if error.code in (401, 403, 429):
                print('Stopped network probes; no challenge or rate-limit bypass attempted.')
                break
        except (ValueError, urllib.error.URLError, TimeoutError):
            print(label + ': response unavailable or not parseable')
    if args.web_json:
        results += candidates(json.loads(args.web_json.read_text()), code, 'desktop-capture')
    best = {}
    for item in results:
        key = (item['item'], item['media_id'], item['source'])
        if key not in best or item['width'] * item['height'] > best[key]['width'] * best[key]['height']:
            best[key] = item
    for item in sorted(best.values(), key=lambda x: (x['item'], x['source'])):
        actual = 'not checked'
        if args.verify:
            try:
                size = image_size(request(item['url'], limit=40 * 1024 * 1024))
                actual = ('%s×%s' % size) if size else 'format not supported by dimension parser'
            except (ValueError, urllib.error.URLError, TimeoutError):
                actual = 'unavailable'
        print('Item {item} | media {media_id} | {source} | advertised {width}×{height} | actual '.format(**item) + actual)
    if not best:
        print('No matching image candidates found. This does not prove a higher-resolution variant is absent.')
    print('No session, signed URLs, raw responses, or media files were saved. No production/B2 changes were made.')


if __name__ == '__main__':
    main()
