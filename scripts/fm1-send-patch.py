#!/usr/bin/env python3
"""Send a compiled .tgp to Teia FM-1_904 over USB MIDI (RAM only).

Examples:
  python scripts/fm1-send-patch.py --status
  python scripts/fm1-send-patch.py --slot 1 path/to/patch.tgp
  python scripts/fm1-send-patch.py --select 2
"""
import argparse
import json
from pathlib import Path
import queue
import secrets
import struct
import time
import zlib

PREFIX = bytes([0x7D, 0x54, 0x45, 1])
ERRORS = {1: "invalid command/length", 2: "transfer missing, expired or out of order", 3: "checksum mismatch", 4: "unsupported or invalid graph", 5: "audio switch busy"}


def pack7(data):
    result = bytearray(); acc = bits = 0
    for byte in data:
        acc |= byte << bits; bits += 8
        while bits >= 7:
            result.append(acc & 127); acc >>= 7; bits -= 7
    if bits:
        result.append(acc)
    return result


def validate_package(data, support):
    """Capability preflight before MIDI access; the device still validates operands/state."""
    if len(data) < 12 or data[:4] != b"TGP1":
        raise RuntimeError("Invalid TGP1 header")
    version, count, registers, values = struct.unpack_from("<4H", data, 4)
    formats = {p["version"]: p for p in support["protocol"]["packages"]}
    if version not in formats:
        raise RuntimeError(f"Unsupported package version {version}")
    fmt = formats[version]
    limits = support["limits"]
    if (not count or count > min(fmt["operations"], limits["operations"])
            or not registers or registers > min(fmt["registers"], limits["registers"])
            or values > min(fmt["values"], limits["values"])
            or len(data) < fmt["headerBytes"]
            or len(data) != fmt["headerBytes"] + count * fmt["operationBytes"] + values * 4):
        raise RuntimeError("Invalid package length or resource counts")
    instructions = {op["code"]: op for op in support["protocol"]["instructions"]}
    functions = {fn["id"] for fn in support["compiler"]["functions"]}
    required = fmt.get("since", 902)
    delay = support["compiler"]["delay"]
    delays = 0
    for i in range(count):
        offset = fmt["headerBytes"] + i * fmt["operationBytes"]
        code = struct.unpack_from("<h", data, offset)[0]
        op = instructions.get(code)
        if op is None or version < op["minimumPackageVersion"]:
            raise RuntimeError(f"Unsupported instruction {code} at operation {i}")
        required = max(required, op["since"])
        if code in (delay["instruction"], delay["legacyInstruction"]):
            delays += 1
            if delays > delay["maxNodes"]:
                raise RuntimeError(f"FM-1 supports at most {delay['maxNodes']} Delay nodes per patch")
            if delays > 1:
                required = max(required, delay["since"])
        if code == 25:
            waveform = struct.unpack_from("<h", data, offset + 18)[0]
            if waveform not in support["compiler"]["oscillatorModes"] or waveform == 6:
                raise RuntimeError("Unsupported oscillator waveform")
        if code == 38 and struct.unpack_from("<h", data, offset + 12)[0] not in functions:
            raise RuntimeError("Unsupported expression function")
    return version, required


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("patch", nargs="?", type=Path)
    parser.add_argument("--slot", type=int, choices=(1, 2), default=1)
    parser.add_argument("--select", type=int, choices=(1, 2))
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--port", default="Teia FM-1 spike", help="exact input/output MIDI port name")
    args = parser.parse_args()
    if sum((args.patch is not None, args.select is not None, args.status)) != 1:
        parser.error("choose a patch, --select, or --status")
    data = args.patch.read_bytes() if args.patch else None
    support = json.loads((Path(__file__).resolve().parents[1] / "firmware/fm1/support.json").read_text())
    version, required_firmware = validate_package(data, support) if data is not None else (0, 0)
    import mido
    if args.port not in mido.get_input_names() or args.port not in mido.get_output_names():
        parser.error(f"expected port {args.port!r}; inputs: {mido.get_input_names()}; outputs: {mido.get_output_names()}")
    incoming = queue.Queue()
    token = secrets.randbelow(127) + 1
    supported_version = 1
    with mido.open_input(args.port, callback=incoming.put) as inp, mido.open_output(args.port) as out:
        time.sleep(0.3)

        def request(command, body=b""):
            nonlocal token, supported_version
            token = token % 127 + 1
            out.send(mido.Message("sysex", data=PREFIX + bytes([command, token]) + pack7(body)))
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    msg = incoming.get(timeout=max(0.001, deadline - time.monotonic()))
                except queue.Empty:
                    break
                raw = bytes(msg.data) if msg.type == "sysex" else b""
                if len(raw) not in (11, 12) or raw[:6] != PREFIX + bytes([command | 0x40, token]):
                    continue
                if raw[6]:
                    if command == 5:
                        raise RuntimeError("This package needs FM-1_904 or newer. Update the firmware before uploading.")
                    raise RuntimeError(ERRORS.get(raw[6], f"device error {raw[6]}"))
                if command == 5:
                    supported_version = raw[11] if len(raw) == 12 else 1
                return raw[7] | raw[8] << 7, raw[9] + 1, raw[10]
            raise RuntimeError("No acknowledgement. This needs upload firmware FM-1_904. If commit timed out, use --status before retrying; the switch may have completed.")

        def describe(result):
            _, active, mask = result
            print(f"Active slot: {active}; loaded slots: {', '.join(str(i+1) for i in range(2) if mask & (1 << i)) or 'none'}; RAM only")

        result = request(0)  # Capability check before any mutation; old firmware times out here.
        if args.status:
            describe(result); return
        if args.select:
            describe(request(4, bytes([args.select - 1]))); return
        if version > 1:
            request(5)
            if supported_version < version:
                raise RuntimeError(f"Device supports package version {supported_version}, but this patch needs {version}; update firmware")
        print(f"Package requires FM-1_{required_firmware}; registry target: {support['firmware']}. Device reports package format only; instruction support is validated on commit.")
        request(1, struct.pack("<BHI", args.slot - 1, len(data), zlib.crc32(data)))
        for offset in range(0, len(data), 96):
            chunk = data[offset:offset + 96]
            result = request(2, struct.pack("<H", offset) + chunk)
            if result[0] != offset + len(chunk):
                raise RuntimeError("Unexpected acknowledged offset; transfer aborted")
        result = request(3)
        print(f"Uploaded {args.patch.name}: {len(data)} bytes to slot {args.slot}; activated after validation")
        describe(result)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ImportError) as error:
        raise SystemExit(f"error: {error}")
