# Privacy Policy — COACH Sudoku

**Short version: your puzzle images never leave your device.**

## What COACH does with your data

### Image processing — local only
Every photo or image you open is processed entirely on your device using
WebAssembly (OpenCV.js). No image, thumbnail, or pixel data is ever uploaded
to any server.

### What is stored in your browser
| Storage | What is kept | When cleared |
|---|---|---|
| Service worker cache | App files (HTML, JS, CSS, model) for offline use | When you clear browser site data |
| IndexedDB `coach-fsa` | A file-system handle to reopen the last-used file | When you clear browser site data |
| IndexedDB `coach-share-inbox` | Temporary buffer for an image shared via the OS share sheet — deleted as soon as the app reads it | Automatically on next app load |
| `localStorage` | Tutorial dismissed flag, install banner dismissed flag, settings | When you clear browser site data |

### Optional: digit-recognition training data
When COACH cannot reliably read a cage total, it offers to share anonymised
digit thumbnails to help improve the recogniser. This upload:

- Only happens if you explicitly tap **"Send this time"** or **"Always send"**
  in the consent modal
- Contains only 64 × 64-pixel greyscale crops of cage-total digits
- Contains **no** puzzle image, no layout data, no personal information
- Is sent to a Cloudflare Worker owned by the app author and stored in
  Cloudflare R2 object storage

### Optional: bug reports
If you use the feedback button to report a wrong hint, a puzzle spec
(cage layout + candidate state, no image) is uploaded. This also requires
explicit action and is never sent automatically.

## What COACH does not do
- No analytics or usage tracking of any kind
- No advertising
- No account or login
- No access to your contacts, location, camera, microphone, or any other
  device capability beyond the file you choose to open

## Open source
The full source code is available at
[github.com/gbarrett28/cagedoku](https://github.com/gbarrett28/cagedoku).
Everything described above can be verified by reading the code.

## Contact
Questions or concerns: open an issue at
[github.com/gbarrett28/cagedoku/issues](https://github.com/gbarrett28/cagedoku/issues).
