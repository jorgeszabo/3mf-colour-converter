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

The conversion command validates a single selected bed and reports unsupported
process and object/volume overrides. It does not claim lossless migration of
arbitrary cross-slicer settings.

## Layout optimization on 2026-11-08

Version 0.2.0 adds `optimize --mode speed|fewer-beds` for configured native INDX
projects. Explicit bed selection is required for multi-bed inputs. Outputs are
one native project with all selected parts, not separate per-bed deliveries.

The supplied six-part Clicker Fidget Spinner was tested end-to-end with alpha13
and eight 0.4 mm HF INDX tools. Four already-converted, reviewed native plates
were the optimization inputs. Geometry, four colours, the two 0.12 mm object
overrides, and inherited single-colour tool choices survived native save/reopen.
Every output bed was extracted without reconversion and freshly sliced.

| Layout | Beds | Normal-mode estimate | Tool changes |
|---|---:|---:|---:|
| Original separation | 4 | 1h 29m 40s | 19 |
| Selected by speed mode | 3 | 1h 25m 26s | 27 |
| Selected by fewer-beds mode | 1 | 2h 00m 09s | 215 |

Speed evaluated the original separation, a fully packed layout, tool groups,
six first-step bed merges and three further merges. Its result is the fastest
evaluated candidate, not a proof of a global minimum. No speed, infill, support,
layer-height, material or other quality setting was reduced to improve time.

Regression tests cover packing bounds/spacing/overflow, metadata and paint
preservation, resource dependency order required by PrusaSlicer, disabled
instances, tool 8, measured-time selection versus fewer-bed selection, splitting
an already-merged source bed, explicit source-bed selection, incompatible bed
temperatures, failed-candidate fallback, altered settings/placement on native
reopen, output/source protection and stale exit-zero native exports. Models,
G-code, reports and logs remain local and ignored. Physical printing is untested;
the source spinner's bridge/stability warnings still require print review.

`npm test`: **31 passing tests** after the layout additions. Both real optimized
outputs were independently reopened again and all their beds sliced, with
geometry/settings/placement checks passing and the same timing totals.

GUI verification exposed alpha13's display-mesh-dependent bed origins: when the
CLI could not resolve the bed STL it used origins based only on the printable
rectangle, while the GUI arranged the full frame. The optimizer now resolves
the installed STL, uses its frame extents for bed origins/spacing, retains a
5 mm printable-edge margin, and validates nonzero bed origins in local print
coordinates. Regression checks cover both edge-touching parts and frame offsets.
