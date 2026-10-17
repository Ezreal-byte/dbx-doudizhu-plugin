"""Rebuild the original soundtrack and offline Mandarin character cue pack.

Build-time only: pip install kokoro==0.9.4 'misaki[zh]==0.9.4' soundfile==0.13.1 'transformers<5'
The distributed plugin contains OGG files, not the model or Python runtime.
Use --samples first to audition the five voices before rendering the complete pack.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio"
REPO = "hexgrad/Kokoro-82M-v1.1-zh"
REVISION = "01e7505bd6a7a2ac4975463114c3a7650a9f7218"
ROLES = [
    {"id": 0, "name": "阿禾", "voice": "zm_009", "speed": 1.08},
    {"id": 1, "name": "小满", "voice": "zf_001", "speed": 1.12},
    {"id": 2, "name": "福伯", "voice": "zm_010", "speed": 0.98},
    {"id": 3, "name": "青竹", "voice": "zf_017", "speed": 1.03},
    {"id": 4, "name": "长安", "voice": "zm_014", "speed": 1.13},
]

LINES = {
    "bid-0": ["这回不叫。", "先让你们来。"],
    "bid-1": ["一分！"],
    "bid-2": ["两分！"],
    "bid-3": ["三分！这把我来！", "三分，开个好局！"],
    "double-0": ["稳一点，不加倍。", "这把不加倍。"],
    "double-1": ["加倍！", "好牌，加倍！"],
    "pass": ["这手不要。", "过，看看你的！", "你先出，我等一等。"],
    "play": ["看我的！", "接好了！"],
    "triple": ["三张！"],
    "triple-single": ["三带一！"],
    "triple-pair": ["三带二！"],
    "straight": ["顺子，一路顺风！", "顺子！"],
    "pair-straight": ["连对！"],
    "airplane": ["飞机，起飞！"],
    "airplane-single": ["飞机带翅膀！"],
    "airplane-pair": ["飞机带对子！"],
    "four-two-single": ["四带二！"],
    "four-two-pair": ["四带两对！"],
    "bomb": ["炸弹！接得住吗？", "炸弹，漂亮！"],
    "rocket": ["王炸！好戏来了！"],
    "win": ["赢啦！这把配合得漂亮！", "好牌，好心情！再来一局！"],
    "lose": ["哎呀，差一点！下局再来！", "这局你厉害，再切磋一把！"],
    "tea": ["来，请你喝杯茶。"],
    "flower": ["送你一朵花，好运到你家！"],
    "tomato": ["嘿，接个番茄！"],
    "egg": ["小心，鸡蛋来啦！"],
    "like": ["这手牌，打得漂亮！"],
    "phrase-hello": ["各位牌友，晚上好！"],
    "phrase-hurry": ["快点吧，花儿都谢了！"],
    "phrase-good": ["这牌打得真漂亮！"],
    "phrase-team": ["和你合作真是太愉快了！"],
    "phrase-again": ["不要走，决战到天亮！"],
    "preview": ["三分！这把我来！嗯，这手不要。好牌，打得漂亮！"],
}
RANKS = {3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九", 10: "十", 11: "勾", 12: "圈", 13: "凯", 14: "尖", 15: "二", 16: "小王", 17: "大王"}
for rank, name in RANKS.items():
    LINES[f"single-{rank}"] = [name + "！"]
    if rank <= 15:
        LINES[f"pair-{rank}"] = ["对" + name + "！"]


def music():
    """An original 32-bar, 104 BPM chamber-folk arrangement, composed here."""
    import numpy as np
    import soundfile as sf
    rate, bpm, bars = 32000, 104, 32
    beat = 60 / bpm
    length = int(bars * 4 * beat * rate)
    mix = np.zeros((length, 2), dtype=np.float64)
    rng = np.random.default_rng(20261017)

    def add(signal, at, gain=1.0, pan=0.0):
        start = int(at * rate)
        if start >= length:
            return
        signal = signal[:length - start]
        mix[start:start + len(signal), 0] += signal * gain * math.sqrt((1 - pan) / 2)
        mix[start:start + len(signal), 1] += signal * gain * math.sqrt((1 + pan) / 2)

    def note(midi, at, duration, gain, instrument="pluck", pan=0):
        t = np.arange(int(duration * rate)) / rate
        f = 440 * 2 ** ((midi - 69) / 12)
        phase = 2 * np.pi * f * t
        if instrument == "flute":
            vibrato = 0.025 * np.sin(t * np.pi * 10) * np.minimum(1, t * 4)
            envelope = np.minimum(1, t / 0.035) * np.minimum(1, (duration - t) / 0.10)
            signal = (np.sin(phase + vibrato) + .20 * np.sin(phase * 2) + .06 * np.sin(phase * 3)) * envelope
        elif instrument == "bass":
            signal = (np.sin(phase) + .23 * np.sin(phase * 2)) * np.exp(-t * 3.5) * np.minimum(1, t / .012)
        elif instrument == "pad":
            envelope = np.minimum(1, t / .18) * np.minimum(1, (duration - t) / .3)
            signal = (np.sin(phase) + .25 * np.sin(phase * 2.002) + .12 * np.sin(phase * 3)) * envelope
        else:
            signal = (np.sin(phase) + .48 * np.sin(phase * 2) + .21 * np.sin(phase * 3) + .09 * np.sin(phase * 4)) * np.exp(-t * 5.5) * np.minimum(1, t / .004)
        add(signal, at, gain, pan)
        # Quiet fixed stereo room taps; baked into the asset, not a runtime reverb.
        if instrument in ("flute", "pluck"):
            add(signal, at + .087, gain * .08, -.65)
            add(signal, at + .151, gain * .05, .65)

    def percussion(at, kind, gain):
        duration = .12 if kind == "hat" else .18
        t = np.arange(int(duration * rate)) / rate
        noise = rng.uniform(-1, 1, len(t))
        if kind == "hat":
            signal = (noise - np.roll(noise, 1)) * np.exp(-t * 60)
        elif kind == "rim":
            signal = (np.sin(2 * np.pi * 1130 * t) + noise * .25) * np.exp(-t * 70)
        else:
            signal = np.sin(2 * np.pi * (56 * t + 10 * (1 - np.exp(-t * 35)))) * np.exp(-t * 26)
        add(signal, at, gain, -.18 if kind == "hat" else .1)

    # D / Bm / G / A, with a contrasting Em / A / F#m / Bm middle eight.
    harmony = [[50, 54, 57], [47, 50, 54], [43, 47, 50], [45, 49, 52]]
    middle = [[40, 43, 47], [45, 49, 52], [42, 45, 49], [47, 50, 54]]
    melody_a = [
        [(74, 0, .75), (78, 1, .45), (81, 1.5, .45), (78, 2, .75), (76, 3, .75)],
        [(74, 0, .45), (71, .5, .45), (74, 1, .75), (78, 2, .75), (76, 3, .45), (74, 3.5, .45)],
        [(71, 0, .75), (74, 1, .75), (79, 2, .45), (78, 2.5, .45), (74, 3, .75)],
        [(76, 0, 1.25), (73, 1.5, .45), (69, 2, .75), (73, 3, .75)],
        [(78, 0, .75), (81, 1, .75), (83, 2, .45), (81, 2.5, .45), (78, 3, .75)],
        [(78, 0, .45), (76, .5, .45), (74, 1, .75), (71, 2, .75), (74, 3, .75)],
        [(79, 0, .75), (78, 1, .45), (74, 1.5, .45), (71, 2, .75), (74, 3, .45), (76, 3.5, .45)],
        [(73, 0, .75), (76, 1, .75), (78, 2, .75), (74, 3, .9)],
    ]
    melody_b = [
        [(76, 0, 1.25), (79, 1.5, .45), (78, 2, .75), (76, 3, .75)],
        [(73, 0, .75), (76, 1, .75), (81, 2, 1.5)],
        [(78, 0, .75), (76, 1, .75), (73, 2, .75), (69, 3, .75)],
        [(71, 0, 1.25), (74, 1.5, .45), (78, 2, 1.5)],
    ]
    for bar in range(bars):
        at = bar * 4 * beat
        is_middle = 16 <= bar < 24
        chord = (middle if is_middle else harmony)[bar % 4]
        for n in chord:
            note(n + 12, at, 3.8 * beat, .032, "pad", -.25)
        for j in range(8):
            swing = .045 * beat if j % 2 else 0
            pitch = chord[[0, 1, 2, 1, 0, 2, 1, 2][j]] + 24
            note(pitch, at + j * beat / 2 + swing, .8, .07 if j % 2 == 0 else .046, "pluck", .32)
        for j in range(4):
            note(chord[0] if j % 2 == 0 else chord[0] + 7, at + j * beat, .7 * beat, .14, "bass", -.05)
            percussion(at + j * beat, "kick", .06 if j % 2 == 0 else .025)
            if j % 2:
                percussion(at + j * beat, "rim", .045)
            percussion(at + (j + .5) * beat, "hat", .022)
        phrase = melody_b[bar % 4] if is_middle else melody_a[bar % 8]
        for pitch, offset, duration in phrase:
            # Opening four bars introduce the motif on plucked strings.
            instrument = "pluck" if bar < 4 else "flute"
            note(pitch, at + offset * beat, duration * beat, .13 if instrument == "flute" else .20, instrument, -.18)
            if bar >= 24 and bar % 2 == 0:
                note(pitch - 12, at + offset * beat, duration * beat, .035, "pluck", .5)
    # Preserve room for dialogue, avoid clipped peaks and a hard loop seam.
    mix = np.tanh(mix * 1.3) * .76
    fade = int(.02 * rate)
    mix[:fade] *= np.linspace(0, 1, fade)[:, None]
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    OUT.mkdir(parents=True, exist_ok=True)
    # libsndfile's Windows Vorbis encoder uses stack storage for a single write;
    # bounded chunks avoid a stack overflow on a full minute of stereo samples.
    with sf.SoundFile(OUT / "garden-table.ogg", "w", samplerate=rate, channels=2, format="OGG", subtype="VORBIS") as stream:
        for offset in range(0, len(mix), 4096):
            stream.write(mix[offset:offset + 4096])
    print(f"Original music: {len(mix) / rate:.2f}s, peak {abs(mix).max():.3f}", flush=True)


def voices(samples=False, refresh_phrases=False):
    # No authenticated service, remote inference, cloned voice, or copyrighted game sample.
    import numpy as np
    import soundfile as sf
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    torch.manual_seed(20261017)
    model_path = hf_hub_download(REPO, "kokoro-v1_1-zh.pth", revision=REVISION)
    config_path = hf_hub_download(REPO, "config.json", revision=REVISION)
    model = KModel(repo_id=REPO, config=config_path, model=model_path).to("cpu").eval()
    pipeline = KPipeline(lang_code="z", repo_id=REPO, model=model, en_callable=lambda text: "")
    manifest = {"format": 1, "model": REPO, "revision": REVISION, "license": "Apache-2.0", "sampleRate": 24000, "roles": ROLES, "cues": {}}
    samples_dir = ROOT / "test-results" / "audio-v02"
    samples_dir.mkdir(parents=True, exist_ok=True)
    report = []
    for role in ROLES:
        voice_path = hf_hub_download(REPO, f"voices/{role['voice']}.pt", revision=REVISION)
        voice = torch.load(voice_path, weights_only=True)
        directory = OUT / "voices" / str(role["id"])
        directory.mkdir(parents=True, exist_ok=True)
        if not samples:
            manifest["cues"][str(role["id"])] = {}
        for key, lines in LINES.items():
            if samples and key != "preview":
                continue
            manifest_entries = []
            for variant, text in enumerate(lines):
                filename = f"{key}-{variant}.ogg"
                output = directory / filename
                started = time.monotonic()
                if not output.exists() or samples or (refresh_phrases and key.startswith("phrase-")):
                    speed = role["speed"]
                    if key in ("bomb", "rocket", "bid-3", "win"):
                        speed *= 1.035
                    if key in ("lose", "tea", "pass"):
                        speed *= .96
                    chunks = [result.audio.numpy() for result in pipeline(text, voice=voice, speed=speed)]
                    if not chunks:
                        raise RuntimeError(f"No speech for {role['id']}/{key}")
                    wav = np.concatenate(chunks)
                    # Short edge silence and even perceived loudness; no formant/pitch distortion.
                    nonzero = np.flatnonzero(abs(wav) > .006)
                    if not len(nonzero):
                        raise RuntimeError(f"Silent speech for {key}")
                    wav = wav[max(0, nonzero[0] - 1100):min(len(wav), nonzero[-1] + 2200)]
                    rms = float(np.sqrt(np.mean(wav ** 2)))
                    # Leave >2 dB of true-peak headroom for Vorbis and Chromium resampling.
                    gain = min(.16 / max(rms, .001), .76 / max(float(abs(wav).max()), .001))
                    wav *= gain
                    fade = min(240, len(wav) // 10)
                    wav[:fade] *= np.linspace(0, 1, fade)
                    wav[-fade:] *= np.linspace(1, 0, fade)
                    sf.write(output, wav, 24000, format="OGG", subtype="VORBIS")
                wav, sample_rate = sf.read(output)
                if float(abs(wav).max()) > .8:
                    wav *= .76 / float(abs(wav).max())
                    sf.write(output, wav, sample_rate, format="OGG", subtype="VORBIS")
                    wav, sample_rate = sf.read(output)
                manifest_entries.append({"file": f"assets/audio/voices/{role['id']}/{filename}", "text": text, "duration": round(len(wav) / sample_rate, 3)})
                report.append({"file": str(output.relative_to(ROOT)).replace("\\", "/"), "text": text, "duration": round(len(wav) / sample_rate, 3), "peak": round(float(abs(wav).max()), 4), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()})
                print(f"{role['id']} {key}:{variant} {len(wav) / sample_rate:.2f}s ({time.monotonic() - started:.2f}s)", flush=True)
                if samples:
                    shutil.copy2(output, samples_dir / f"role-{role['id']}-preview.ogg")
            if not samples:
                manifest["cues"][str(role["id"])][key] = manifest_entries
    if not samples:
        (OUT / "voice-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        shutil.copy2(OUT / "voice-manifest.json", ROOT / "src" / "game" / "voice-manifest.json")
    (samples_dir / ("samples.json" if samples else "generated.json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sync_public():
    if OUT.exists():
        shutil.copytree(OUT, ROOT / "public" / "assets" / "audio", dirs_exist_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", action="store_true")
    parser.add_argument("--music-only", action="store_true")
    parser.add_argument("--voices-only", action="store_true")
    parser.add_argument("--refresh-phrases", action="store_true")
    args = parser.parse_args()
    if not args.voices_only and not args.samples:
        music()
    if not args.music_only:
        voices(args.samples, args.refresh_phrases)
    sync_public()
