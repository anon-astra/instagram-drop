import struct
import unittest
from highres_probe import Scripts, candidates, image_size, media_id, valid_cdn


class HighResTests(unittest.TestCase):
    def test_cdn_boundary(self):
        self.assertTrue(valid_cdn('https://a.fbcdn.net/image.jpg?token=unchanged'))
        self.assertFalse(valid_cdn('https://evilfbcdn.net/image.jpg'))
        self.assertFalse(valid_cdn('https://a.fbcdn.net@evil.test/image.jpg'))
        self.assertFalse(valid_cdn('http://a.fbcdn.net/image.jpg'))

    def test_exact_post_carousel(self):
        doc = {'items': [{'code': 'ABC', 'carousel_media': [
            {'pk': '100', 'media_type': 1, 'image_versions2': {'candidates': [
                {'width': 1080, 'height': 1350, 'url': 'https://a.fbcdn.net/low.jpg'},
                {'width': 3072, 'height': 3840, 'url': 'https://a.fbcdn.net/high.jpg?x=1&y=2'}]}},
            {'pk': '101', 'media_type': 2, 'image_versions2': {'candidates': [
                {'width': 1080, 'height': 1920, 'url': 'https://a.fbcdn.net/thumb.jpg'}]}}
        ]}, {'code': 'OTHER', 'image_versions2': {'candidates': []}}]}
        found = candidates(doc, 'ABC', 'mobile-baseline')
        self.assertEqual(len(found), 2)
        self.assertEqual(found[1]['url'], 'https://a.fbcdn.net/high.jpg?x=1&y=2')
        self.assertTrue(all(i['item'] == 1 and i['media_id'] == '100' for i in found))
        self.assertEqual(candidates(doc, 'DEF', 'desktop-page'), [])

    def test_web_resources(self):
        doc = {'shortcode': 'ABC', 'id': media_id('ABC'), 'display_resources': [
            {'config_width': 3072, 'config_height': 2048, 'src': 'https://a.cdninstagram.com/high.jpg'}]}
        self.assertEqual(candidates(doc, 'ABC', 'desktop-page')[0]['width'], 3072)
        self.assertEqual(candidates(doc, 'ABC', 'mobile-baseline'), [])

    def test_html_json_no_execution(self):
        p = Scripts()
        p.feed('<script>alert(1)</script><script type="application/json">{"items":[]}</script>')
        self.assertEqual(p.documents, [{'items': []}])

    def test_actual_dimensions(self):
        png = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 3072, 2048)
        self.assertEqual(image_size(png), (3072, 2048))
        jpeg = b'\xff\xd8\xff\xc0' + struct.pack('>HBHHB', 17, 8, 3840, 3072, 3)
        self.assertEqual(image_size(jpeg), (3072, 3840))
        self.assertIsNone(image_size(b'not an image'))


if __name__ == '__main__':
    unittest.main()
