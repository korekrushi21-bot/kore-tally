import sounddevice as sd
import numpy as np

for dev in [1, 6, 12, 14]:
    try:
        rec = sd.rec(16000, samplerate=16000, channels=1, dtype='int16', device=dev)
        sd.wait()
        rms = np.sqrt(np.mean(rec.astype(np.float32)**2))
        print(f'Device {dev}: RMS={rms:.1f} {"OK" if rms>100 else "LOW"}')
    except Exception as e:
        print(f'Device {dev}: ERROR - {e}')