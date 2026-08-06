# Document acquisition fixtures

All files are synthetic and contain no third-party research material.

- `tiny.pdf` and `not-pdf.html` cover acquisition media, size, hash, and immutable-copy checks.
- `text-layer.pdf` has two stable pages with headings and body text.
- `scanned.pdf` is a raster page with only a real PDF page number in its text layer; it must remain `OCR_REQUIRED`.
- `partial-text-layer.pdf` combines one text page and one raster page.
- `encrypted.pdf` and `corrupt.pdf` exercise structured parser failures.
