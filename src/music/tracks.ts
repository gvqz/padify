/**
 * Track library for the Padify generative music player.
 *
 * Every track is a *recipe*, not a recording: the Web Audio engine in
 * `engine.ts` renders it deterministically from these numbers (seeded PRNG
 * streams per layer). Chords are scale-degree stacks that cycle every
 * CHORD_BARS bars (see engine); degrees resolve against `scale`, which lists
 * semitone offsets from `rootMidi`, wrapping octave-up as needed.
 */

export interface LayerCfg {
    /** 0..1 overall loudness of the layer; 0 (or ~0) disables the layer. */
    gain: number;
    /** 0..1 event probability / pattern liveliness. */
    density: number;
}

export type PlaylistId = 'focus' | 'calm' | 'sleep' | 'uplift';

export interface Track {
    id: string;
    title: string;
    playlist: PlaylistId;
    /** Total playback length in seconds. */
    durationSec: number;
    /** Tempo. Beat grid = 4 beats per bar; chords advance every 4 bars. */
    bpm: number;
    /** MIDI note number of the scale root (60 = C4). */
    rootMidi: number;
    /** Semitone offsets from the root, ascending (may span > 1 octave). */
    scale: number[];
    /** Chord voicings as scale-degree stacks, cycled every 4 bars. */
    chords: number[][];
    layers: {
        pad: LayerCfg;
        pluck: LayerCfg;
        bells: LayerCfg;
        bass: LayerCfg;
        noise: LayerCfg;
    };
    /** Convolution reverb wet mix, 0..1. */
    reverbWet: number;
    /** Master lowpass cutoff base (Hz); a slow LFO drifts around it. */
    filterHz: number;
    /** PRNG seed — same seed ⇒ same music on every playback. */
    seed: number;
    /** Three hex colors driving the procedural album art. */
    artPalette: [string, string, string];
}

export const PLAYLIST_LABELS: Record<PlaylistId, string> = {
    focus: 'Focus',
    calm: 'Calm',
    sleep: 'Sleep',
    uplift: 'Uplift'
};

export const TRACKS: Track[] = [
    // ---- Focus ------------------------------------------------------------
    {
        id: 'deep-current',
        title: 'Deep Current',
        playlist: 'focus',
        durationSec: 312, // 5:12
        bpm: 72,
        rootMidi: 57, // A3
        scale: [0, 3, 5, 7, 10, 12, 15, 17], // A minor pentatonic, 2 octaves
        chords: [
            [0, 2, 4],
            [1, 3, 5],
            [0, 3, 6],
            [2, 4, 6]
        ],
        layers: {
            pad: { gain: 0.5, density: 0.55 },
            pluck: { gain: 0.42, density: 0.6 },
            bells: { gain: 0.22, density: 0.35 },
            bass: { gain: 0.45, density: 0.3 },
            noise: { gain: 0.16, density: 0.45 }
        },
        reverbWet: 0.45,
        filterHz: 2400,
        seed: 110117,
        artPalette: ['#33506b', '#7fa0b8', '#d9a066']
    },
    {
        id: 'library-hours',
        title: 'Library Hours',
        playlist: 'focus',
        durationSec: 288, // 4:48
        bpm: 60,
        rootMidi: 50, // D3
        scale: [0, 2, 3, 5, 7, 8, 10, 12], // D natural minor
        chords: [
            [0, 2, 4],
            [3, 5, 7],
            [4, 6, 8],
            [5, 7, 9]
        ],
        layers: {
            pad: { gain: 0.32, density: 0.35 },
            pluck: { gain: 0.14, density: 0.22 },
            bells: { gain: 0.3, density: 0.28 },
            bass: { gain: 0.35, density: 0.25 },
            noise: { gain: 0.3, density: 0.6 } // filtered paper-room bed
        },
        reverbWet: 0.5,
        filterHz: 1100,
        seed: 110228,
        artPalette: ['#6b4f2e', '#a9825a', '#d8c3a0']
    },
    {
        id: 'ink-flow',
        title: 'Ink Flow',
        playlist: 'focus',
        durationSec: 336, // 5:36
        bpm: 84,
        rootMidi: 60, // C4
        scale: [0, 2, 4, 6, 7, 9, 11, 12], // C lydian
        chords: [
            [0, 2, 4],
            [1, 3, 5],
            [5, 7, 9],
            [3, 5, 7]
        ],
        layers: {
            pad: { gain: 0.3, density: 0.4 },
            pluck: { gain: 0.5, density: 0.78 }, // felt plucks
            bells: { gain: 0.2, density: 0.4 },
            bass: { gain: 0.4, density: 0.3 },
            noise: { gain: 0.12, density: 0.35 }
        },
        reverbWet: 0.4,
        filterHz: 3200,
        seed: 110339,
        artPalette: ['#4a3b5c', '#8a6fa8', '#c9b7a8']
    },
    {
        id: 'circuit-garden',
        title: 'Circuit Garden',
        playlist: 'focus',
        durationSec: 300, // 5:00
        bpm: 96,
        rootMidi: 52, // E3
        scale: [0, 2, 3, 5, 7, 8, 10, 12], // E natural minor
        chords: [
            [0, 2, 4],
            [5, 7, 9],
            [3, 5, 7],
            [4, 6, 8]
        ],
        layers: {
            pad: { gain: 0.26, density: 0.5 },
            pluck: { gain: 0.5, density: 0.88 }, // synth arps, 16th grid
            bells: { gain: 0.18, density: 0.45 },
            bass: { gain: 0.4, density: 0.35 },
            noise: { gain: 0.14, density: 0.4 }
        },
        reverbWet: 0.35,
        filterHz: 2800,
        seed: 110441,
        artPalette: ['#2f5d46', '#6f9c7f', '#c47a4a']
    },

    // ---- Calm --------------------------------------------------------------
    {
        id: 'morning-fog',
        title: 'Morning Fog',
        playlist: 'calm',
        durationSec: 364, // 6:04
        bpm: 56,
        rootMidi: 53, // F3
        scale: [0, 2, 4, 5, 7, 9, 11, 12], // F major
        chords: [
            [0, 2, 4],
            [3, 5, 7],
            [4, 6, 8],
            [1, 3, 5]
        ],
        layers: {
            pad: { gain: 0.55, density: 0.45 },
            pluck: { gain: 0.1, density: 0.18 },
            bells: { gain: 0.3, density: 0.32 }, // sparse bells
            bass: { gain: 0.4, density: 0.25 },
            noise: { gain: 0.2, density: 0.5 }
        },
        reverbWet: 0.55,
        filterHz: 1600,
        seed: 110552,
        artPalette: ['#8a8f99', '#c8ccd4', '#e8b88a']
    },
    {
        id: 'paper-boats',
        title: 'Paper Boats',
        playlist: 'calm',
        durationSec: 272, // 4:32
        bpm: 76,
        rootMidi: 55, // G3
        scale: [0, 2, 4, 5, 7, 9, 11, 12], // G major
        chords: [
            [0, 2, 4],
            [4, 6, 8],
            [5, 7, 9],
            [3, 5, 7]
        ],
        layers: {
            pad: { gain: 0.28, density: 0.4 },
            pluck: { gain: 0.5, density: 0.72 }, // marimba-ish plucks
            bells: { gain: 0.24, density: 0.38 },
            bass: { gain: 0.42, density: 0.3 },
            noise: { gain: 0.12, density: 0.3 }
        },
        reverbWet: 0.42,
        filterHz: 3000,
        seed: 110663,
        artPalette: ['#c98f5e', '#e8d5b5', '#7ba7a0']
    },
    {
        id: 'slow-tide',
        title: 'Slow Tide',
        playlist: 'calm',
        durationSec: 372, // 6:12
        bpm: 50,
        rootMidi: 45, // A2
        scale: [0, 2, 3, 5, 7, 8, 10, 12], // A natural minor
        chords: [
            [0, 2, 4],
            [5, 7, 9],
            [3, 5, 7],
            [0, 3, 5]
        ],
        layers: {
            pad: { gain: 0.52, density: 0.5 }, // pad swells
            pluck: { gain: 0.08, density: 0.14 },
            bells: { gain: 0.18, density: 0.28 },
            bass: { gain: 0.38, density: 0.25 },
            noise: { gain: 0.3, density: 0.85 } // wave-like LFO
        },
        reverbWet: 0.6,
        filterHz: 1400,
        seed: 110774,
        artPalette: ['#1f4e5f', '#3a7d8c', '#bcd9d4']
    },

    // ---- Sleep --------------------------------------------------------------
    {
        id: 'night-drift',
        title: 'Night Drift',
        playlist: 'sleep',
        durationSec: 480, // 8:00
        bpm: 44,
        rootMidi: 50, // D3
        scale: [0, 2, 3, 5, 7, 8, 10, 12], // D natural minor
        chords: [
            [0, 2, 4],
            [0, 3, 5]
        ],
        layers: {
            pad: { gain: 0.5, density: 0.22 }, // drone, very sparse
            pluck: { gain: 0, density: 0.1 },
            bells: { gain: 0.12, density: 0.1 },
            bass: { gain: 0.42, density: 0.18 },
            noise: { gain: 0.2, density: 0.3 }
        },
        reverbWet: 0.65,
        filterHz: 900,
        seed: 110885,
        artPalette: ['#232a3d', '#3d4a63', '#6d5b8c']
    },
    {
        id: 'moon-ledger',
        title: 'Moon Ledger',
        playlist: 'sleep',
        durationSec: 444, // 7:24
        bpm: 48,
        rootMidi: 50, // D3
        scale: [0, 2, 3, 5, 7, 8, 10, 12], // D natural minor
        chords: [
            [0, 2, 4],
            [3, 5, 7]
        ],
        layers: {
            pad: { gain: 0.48, density: 0.2 }, // drone
            pluck: { gain: 0, density: 0.1 },
            bells: { gain: 0.22, density: 0.14 }, // rare bell
            bass: { gain: 0.4, density: 0.18 },
            noise: { gain: 0.15, density: 0.3 }
        },
        reverbWet: 0.6,
        filterHz: 1100,
        seed: 110996,
        artPalette: ['#2c3350', '#575e82', '#b8bdd0']
    },
    {
        id: 'weightless-hours',
        title: 'Weightless Hours',
        playlist: 'sleep',
        durationSec: 480, // 8:00
        bpm: 40,
        rootMidi: 48, // C3
        scale: [0, 2, 4, 5, 7, 9, 11, 12], // C major
        chords: [
            [0, 2, 4],
            [5, 7, 9],
            [4, 6, 8]
        ],
        layers: {
            pad: { gain: 0.5, density: 0.16 }, // minimal, slow
            pluck: { gain: 0.1, density: 0.1 },
            bells: { gain: 0.14, density: 0.12 },
            bass: { gain: 0.36, density: 0.15 },
            noise: { gain: 0.18, density: 0.4 }
        },
        reverbWet: 0.62,
        filterHz: 1000,
        seed: 111107,
        artPalette: ['#8c6a5d', '#b89a88', '#d9c9b8']
    },

    // ---- Uplift --------------------------------------------------------------
    {
        id: 'first-light',
        title: 'First Light',
        playlist: 'uplift',
        durationSec: 256, // 4:16
        bpm: 108,
        rootMidi: 60, // C4
        scale: [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 19], // C major, wide
        chords: [
            [0, 2, 4],
            [3, 5, 7],
            [4, 6, 8],
            [5, 7, 9]
        ],
        layers: {
            pad: { gain: 0.36, density: 0.55 },
            pluck: { gain: 0.55, density: 0.9 }, // brighter 16th arps
            bells: { gain: 0.3, density: 0.5 },
            bass: { gain: 0.45, density: 0.4 },
            noise: { gain: 0.15, density: 0.35 }
        },
        reverbWet: 0.38,
        filterHz: 3600,
        seed: 111218,
        artPalette: ['#d97a4a', '#f0b060', '#f5dcb0']
    },
    {
        id: 'meadow-walk',
        title: 'Meadow Walk',
        playlist: 'uplift',
        durationSec: 280, // 4:40
        bpm: 92,
        rootMidi: 55, // G3
        scale: [0, 2, 4, 5, 7, 9, 11, 12, 14, 16], // G major, wide
        chords: [
            [0, 2, 4],
            [5, 7, 9],
            [3, 5, 7],
            [4, 6, 8]
        ],
        layers: {
            pad: { gain: 0.3, density: 0.45 },
            pluck: { gain: 0.5, density: 0.8 },
            bells: { gain: 0.34, density: 0.6 }, // shimmer
            bass: { gain: 0.42, density: 0.35 },
            noise: { gain: 0.2, density: 0.45 }
        },
        reverbWet: 0.48,
        filterHz: 3200,
        seed: 111329,
        artPalette: ['#5d8c46', '#a0c070', '#f0d060']
    }
];

export function getTrackById(id: string): Track | undefined {
    return TRACKS.find(track => track.id === id);
}

/** Formats seconds as m:ss. */
export function formatTime(sec: number): string {
    const clamped = Math.max(0, Math.floor(sec));
    const minutes = Math.floor(clamped / 60);
    const seconds = clamped % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
