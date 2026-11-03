# Validation on 2026-11-03

Environment: PrusaSlicer **3.0.0-alpha13**, Prusa Research FFF vendor **1.0.21**,
CORE One INDX 8T, eight **0.4 mm HF** tools. The generated profile snapshot
contains 21 compatible installed material presets. No physical prints were run.

`npm test`: **21 passing regression tests**, including unit normalization,
production submodel units, disabled instances in all three writers, native
alpha13 printability metadata, paint remapping through tool 8, explicit colour
merges, multi-bed selection, every current material, process retention and a
slicer that exits zero without producing output.

Native end-to-end checks used the chat CLI and the actual converted 3MF:

| Case | Outcome |
|---|---|
| AquaStar round-collar fit test | Reopened and sliced; retained PETG, 0.15 mm, five walls, 40% infill, one used tool |
| Heart source bed 1 | Selected separately, reopened and sliced |
| Heart source bed 2 | Selected separately, reopened and sliced |
| Bambu X-wing kit plate | Selected 31 objects / 315,452 triangles / 165,231 painted triangles; reopened and sliced |
| Bambu X-wing assembled display plate | Refused: the assembly exceeds the smaller target bed |
| Multicolour axolotl | 734,726 triangles / 19,962 painted triangles; reopened and sliced |
| Synthetic cube with disabled second instance | Native reopen retained the disabled instance; sliced the enabled instance |
| Browser Heart bed 2 download | Bed picker, INDX target, settings audit and download exercised; downloaded file reopened and sliced through CLI |

Native validation records missing local bed-mesh and physical-printer-storage
messages as warnings rather than treating them as proof of failed slicing.
Every successful case produced fresh G-code. Source models and validation
artifacts are kept locally and excluded from the repository.

Alpha13 ignores XML `printable` on native projects. The writer additionally
stores disabled instances in the project object's `instances` array using
global build-item `ord` and `printable: false`. The reader restores those flags
from native metadata. This follows the versioned
[PrusaFile.cpp implementation](https://github.com/prusa3d/PrusaSlicer/blob/version_3.0.0-alpha13/src/slic3r-shared/src/Slic3r/Biz/Format/3mf/PrusaFile.cpp#L1354).

The CLI validates a single selected bed and reports unsupported process and
object/volume overrides. It does not claim lossless migration of arbitrary
cross-slicer settings or preservation of a whole multi-bed project in one file.
