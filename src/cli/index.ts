import { parseArgs } from "node:util";
import { inspect } from "./inspect.ts";
import { prepare } from "./prepare.ts";
import { fallback } from "./fallback.ts";
import { extractChapters, sidecarToFfmetadata } from "./chapters.ts";
import { spherical } from "./sphericalCmd.ts";
import { bold, dim, fail, cyan } from "./log.ts";

const USAGE = `
${bold("homecast")} — 360° video toolchain ${dim("(PLAN §6, M1)")}

${cyan("homecast inspect")} <file>
    Probe a file and report everything the player cares about: resolution and
    equirect aspect, bit depth, angular resolution, chapters, spherical metadata,
    and the full codec string to use with canPlayType.

${cyan("homecast prepare")} <input> [options]
    Remux with -c copy (bit-identical, no re-encode), optionally injecting
    chapters, then verify the result with ffprobe.
      -o, --output <file>      default: <input>.homecast.mp4
      -c, --chapters <file>    a .homecast.json sidecar, or a raw .txt ffmetadata
          --title <string>     global title tag
          --artist <string>    global artist tag
          --no-retag           keep the source fourcc (default retags hvc1 → hev1)
          --no-spherical       skip re-injecting the 360° metadata ffmpeg drops
          --no-sv3d            inject only Apple's vexu box, not Google's sv3d
          --overwrite          replace an existing output
          --force              skip the 2×-input free-space guard (§3.6)

${cyan("homecast fallback")} <input> [options]
    Conditional 4K H.264 encode for viewers who cannot decode HEVC (§4.1).
      -o, --output <file>      default: <input>.3840.h264.mp4
      -w, --width <px>         default 3840 (height is always width/2, §5.7)
      -b, --bitrate <Mbps>     default 60
          --overwrite

${cyan("homecast spherical")} <file> [--source <original>] [--check]
    Put back the 360° metadata that ffmpeg's mov muxer drops on every remux.
    Copies the original's box when --source is given, otherwise writes a fresh
    equirectangular one. --check reports without modifying anything.
      -s, --source <file>      copy the boxes from this file
          --check              report only
          --no-sv3d            skip Google's st3d/sv3d form (VLC reads it)

${cyan("homecast chapters extract")} <video> [-o <file>]
    Read embedded MP4 chapters back out into a JSON sidecar.

${cyan("homecast chapters ffmeta")} <sidecar.json> -o <file>
    Convert a sidecar into an ffmetadata file for \`prepare --chapters\`.

Environment: HOMECAST_FFMPEG, HOMECAST_FFPROBE override the tool paths.
`;

function requirePositional(positionals: string[], index: number, what: string): string {
  const v = positionals[index];
  if (v === undefined) throw new Error(`missing ${what}\n${USAGE}`);
  return v;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const rest = argv.slice(1);

  switch (command) {
    case "inspect": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      await inspect(requirePositional(positionals, 0, "<file>"));
      return 0;
    }

    case "prepare": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          output: { type: "string", short: "o" },
          chapters: { type: "string", short: "c" },
          title: { type: "string" },
          artist: { type: "string" },
          "no-retag": { type: "boolean", default: false },
          "no-spherical": { type: "boolean", default: false },
          "no-sv3d": { type: "boolean", default: false },
          overwrite: { type: "boolean", default: false },
          force: { type: "boolean", default: false },
        },
      });
      await prepare({
        input: requirePositional(positionals, 0, "<input>"),
        output: values.output,
        chapters: values.chapters,
        title: values.title,
        artist: values.artist,
        retag: !values["no-retag"],
        spherical: !values["no-spherical"],
        googleForm: !values["no-sv3d"],
        overwrite: values.overwrite,
        force: values.force,
      });
      return 0;
    }

    case "fallback": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          output: { type: "string", short: "o" },
          width: { type: "string", short: "w", default: "3840" },
          bitrate: { type: "string", short: "b", default: "60" },
          overwrite: { type: "boolean", default: false },
        },
      });
      await fallback({
        input: requirePositional(positionals, 0, "<input>"),
        output: values.output,
        width: Number(values.width),
        bitrate: Number(values.bitrate),
        overwrite: values.overwrite,
      });
      return 0;
    }

    case "spherical": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          source: { type: "string", short: "s" },
          check: { type: "boolean", default: false },
          "no-sv3d": { type: "boolean", default: false },
        },
      });
      await spherical({
        file: requirePositional(positionals, 0, "<file>"),
        source: values.source,
        check: values.check,
        googleForm: !values["no-sv3d"],
      });
      return 0;
    }

    case "chapters": {
      const sub = rest[0];
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        allowPositionals: true,
        options: { output: { type: "string", short: "o" } },
      });
      if (sub === "extract") {
        await extractChapters(requirePositional(positionals, 0, "<video>"), values.output);
        return 0;
      }
      if (sub === "ffmeta") {
        const out = values.output;
        if (!out) throw new Error("chapters ffmeta needs -o <file>");
        await sidecarToFfmetadata(requirePositional(positionals, 0, "<sidecar.json>"), out);
        return 0;
      }
      throw new Error(`unknown chapters subcommand: ${sub ?? "(none)"}\n${USAGE}`);
    }

    default:
      throw new Error(`unknown command: ${command}\n${USAGE}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  fail((err as Error).message);
  process.exitCode = 1;
}
