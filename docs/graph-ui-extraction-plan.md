# Spagbol extraction and Teia adoption

The shared library is one package, `@pauloricca/spagbol`. Teia and the minimal example both consume its complete `SpagbolCanvas` and `GraphEditor`. Teia's separate canvas state, history, connection gestures and cable renderer are removed.

Spagbol owns the reusable graph model and commands, node frames and ports, type conversion and port remapping, selection scaling, link types and controls, duplication, clipboard/history, pan bounds, areas, grouping and built-in Group/Ins/Outs, navigation and instance control panels. Node definitions and views register additional node types and specialized content. Generic slots support domain parameter widgets, extra menu/transport controls, catalogue capability filtering and non-editable virtual relations. Domain invariants run inside the same atomic edit.

Teia owns its DSP definitions/compiler, specialized graphics and parameter widgets, asset and buffer lifecycle, MIDI/engine observations, save/load codecs and hosted/FM-1 integrations. Existing patch formats are preserved through the compatibility codec. The example remains a minimal app with four example definitions plus library-owned grouping.

Static compilation and document/compiler equivalence checks accompany the migration. They do not establish browser, audio, hosted/native or hardware behavior. Functional testing should exercise the complete shared canvas and app bindings after installing the updated packed dependency with Docker Compose. visual-visual remains unchanged.
