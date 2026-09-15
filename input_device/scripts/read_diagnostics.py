"""Read the attached input tool's saved diagnostics over USB serial."""
import glob
import os
import select
import termios
import time
import tty


def find_port():
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
    if len(ports) != 1:
        raise SystemExit("Connect exactly one XIAO serial port.")
    return ports[0]


class Serial:
    def __init__(self, path):
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self.fd)
        attrs[4] = termios.B115200
        attrs[5] = termios.B115200
        attrs[2] |= termios.CLOCAL | termios.CREAD
        attrs[3] = 0
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        tty.setraw(self.fd)
        self.buffer = b""

    def write(self, data):
        os.write(self.fd, data)

    def line(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                return line.rstrip(b"\r").decode("utf-8", "replace")
            ready, _, _ = select.select([self.fd], [], [], max(0, deadline - time.monotonic()))
            if ready:
                self.buffer += os.read(self.fd, 4096)
        raise TimeoutError("Timed out waiting for diagnostics.")

    def close(self):
        os.close(self.fd)


serial = Serial(find_port())
try:
    serial.write(b"LOG\n")
    while True:
        line = serial.line(timeout=5)
        print(line)
        if line == "END DIAGNOSTICS":
            break
finally:
    serial.close()
