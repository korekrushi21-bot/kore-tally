import logging
import numpy as np
import sounddevice as sd
from scipy.io.wavfile import write as write_wav
from scipy.signal import butter, sosfilt
from faster_whisper import WhisperModel
from typing import Optional, List
from pathlib import Path


class STTEngine:
    def __init__(self, config: dict):
        self.config = config
        self.model = None
        self.sample_rate = int(config.get("sample_rate", 16000))
        self.record_seconds = float(config.get("record_seconds", 5.0))
        self.wake_record_seconds = float(config.get("wake_record_seconds", 3.0))
        self.language = config.get("language", "auto")
        self.input_device = config.get("input_device")
        self.model_size = config.get("model", "small")
        self.device = config.get("device", "cpu")
        self.compute_type = config.get("compute_type", "int8")
        self._model_cache_dir = Path(config.get("model_cache_dir", "./_models"))

    def load_model(self):
        if self.model is None:
            logging.info(f"Loading Whisper model: {self.model_size} on {self.device}")
            self.model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
                download_root=str(self._model_cache_dir),
            )
            logging.info("Whisper model loaded")

    def unload_model(self):
        self.model = None

    def record_audio(self, duration: Optional[float] = None) -> np.ndarray:
        seconds = duration or self.record_seconds
        logging.debug(f"Recording for {seconds}s at {self.sample_rate}Hz")
        try:
            recording = sd.rec(
                int(seconds * self.sample_rate),
                samplerate=self.sample_rate,
                channels=1,
                dtype="int16",
                device=self.input_device,
            )
            sd.wait()
        except sd.PortAudioError as e:
            logging.warning(f"Microphone error: {e}")
            raise
        return recording.reshape(-1)

    def preprocess_audio(self, audio: np.ndarray) -> np.ndarray:
        if audio.size == 0:
            return audio

        cleaned = audio.astype(np.float32)
        cleaned -= float(np.mean(cleaned))
        sos = butter(2, 80, btype="highpass", fs=self.sample_rate, output="sos")
        cleaned = sosfilt(sos, cleaned)
        peak = float(np.max(np.abs(cleaned))) if cleaned.size else 0.0
        if peak > 1.0:
            cleaned *= (0.88 * 32767.0) / peak
        return np.clip(cleaned, -32768, 32767).astype(np.int16)

    def trim_silence(self, audio: np.ndarray, threshold_factor: float = 2.8) -> np.ndarray:
        frame = max(1, int(self.sample_rate * 0.03))
        frame_count = len(audio) // frame
        if frame_count == 0:
            return audio

        framed = audio[:frame_count * frame].reshape(frame_count, frame)
        levels = np.sqrt(np.mean(framed.astype(np.float32) ** 2, axis=1))
        noise = float(np.percentile(levels, 30))
        threshold = max(120.0, noise * threshold_factor)
        active = np.flatnonzero(levels >= threshold)

        if active.size == 0:
            return audio[:0]

        pad = int(0.35 / 0.03)
        first = max(0, int(active[0]) - pad) * frame
        last = min(frame_count, int(active[-1]) + pad + 1) * frame
        return audio[first:last]

    def transcribe(self, audio: np.ndarray, language: Optional[str] = None,
                   hotwords: Optional[str] = None, beam_size: int = 3,
                   initial_prompt: Optional[str] = None) -> str:
        if self.model is None:
            self.load_model()

        temp_file = Path("temp_command.wav")
        write_wav(str(temp_file), self.sample_rate, audio)

        lang = language or self.language
        if lang == "auto":
            lang = None

        segments, _ = self.model.transcribe(
            str(temp_file),
            language=lang,
            beam_size=beam_size,
            best_of=3,
            patience=1.0,
            repetition_penalty=1.18,
            no_repeat_ngram_size=3,
            temperature=0.0,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 450,
                "speech_pad_ms": 350,
            },
            condition_on_previous_text=False,
            hallucination_silence_threshold=1.0,
            initial_prompt=initial_prompt,
            hotwords=hotwords,
            without_timestamps=True,
            max_new_tokens=100,
        )

        result = " ".join(segment.text.strip() for segment in segments).strip()

        temp_file.unlink(missing_ok=True)

        words = result.split()
        if words and max(words.count(w) for w in set(words)) >= 5:
            logging.warning("Rejected repeated-word hallucination")
            return ""

        return result

    def listen_for_wake(self, hotwords: str = "टॅली सुरू कर") -> bool:
        try:
            audio = self.record_audio(self.wake_record_seconds)
        except sd.PortAudioError:
            return False

        if audio.size == 0:
            return False

        rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
        if rms < 90:
            return False

        audio = self.preprocess_audio(audio)
        text = self.transcribe(
            audio,
            language="mr",
            hotwords=hotwords,
            beam_size=1,
            best_of=1,
            initial_prompt="टॅली सुरू कर",
        )
        return self._check_wake_phrase(text)

    def _check_wake_phrase(self, text: str) -> bool:
        from utils import normalize
        clean = re.sub(r"[^a-z0-9\u0900-\u097f]+", " ", normalize(text)).strip()
        tokens = clean.split()
        if not tokens or len(tokens) > 4:
            return False

        wake_variants = [
            "टॅली सुरू कर",
            "टॅली सुरु कर",
            "टेली सुरू कर",
            "टाली सुरू कर",
            "tally suru kar",
            "tally start",
            "hey tally",
        ]
        normalized_variants = {normalize(v) for v in wake_variants}
        return clean in normalized_variants

    def listen_command(self, session: Optional[dict] = None) -> str:
        try:
            audio = self.record_audio()
        except sd.PortAudioError as e:
            logging.warning(f"Microphone unavailable during command: {e}")
            raise

        audio = self.preprocess_audio(audio)
        audio = self.trim_silence(audio)

        if audio.size == 0:
            return ""

        cmd_language = self.language
        if session and session.get("outstanding_party"):
            cmd_language = "mr"
        if cmd_language == "auto":
            cmd_language = None

        hotwords = (
            "बिल सेल्स पार्टी माल नग दर रक्कम बरोबर हो रद्द बाकी स्टॉक "
            "ग्राहक कस्टमर सप्लायर आइटम क्वांटिटी कन्फर्म फायनल "
            "अमिस्टार युरिया डीएपी पोटाश सुफला एसएसपी बियाणे"
        )

        initial_prompt = (
            "मराठी Tally आदेश: ग्राहक राम ट्रेडर्स; माल युरिया 45 किलो; "
            "नग दोन; दर तीनशे; बरोबर; बिल बनव; ग्राहक बाकी; स्टॉक दाखवा।"
        )

        return self.transcribe(
            audio,
            language=cmd_language,
            hotwords=hotwords,
            beam_size=3,
            initial_prompt=initial_prompt,
        )


import re