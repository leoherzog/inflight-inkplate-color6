# Inkplate 6COLOR Specifications and Features

Based on the official [Soldered Documentation](https://docs.soldered.com/inkplate/6color/overview/), here are the specifications and features of the **InkPlate 6COLOR**:

### **Display Specifications**
*   **Type:** 5.85-inch color e-paper display.
*   **Resolution:** 600 × 448 pixels.
*   **Color Support:** 7 distinct colors (Black, White, Red, Yellow, Blue, Green, and Orange).
*   **Refresh Time:** Approximately 12 seconds for a full refresh.

### **Core Hardware**
*   **Microcontroller:** ESP32-WROVER-E module (Dual-core 240MHz, Integrated Wi-Fi and Bluetooth 4.2 BLE).
*   **Memory:** 8 MB PSRAM (crucial for 7-color dithering and full image buffers).
*   **Flash:** 4 MB SPI Flash.
*   **Storage:** Built-in microSD card slot (ideal for storing images and data).
*   **Real-Time Clock (RTC):** Included for time-sensitive applications.
*   **Expansion Ports:** GPIO, I²C, SPI, and EasyC/Qwiic-compatible connectors.

### **Power Management**
*   **Power Sources:** USB or Li-Ion battery.
*   **Battery Management:** Onboard charger for Li-Ion batteries.
*   **Ultra-Low Power:** Consumes only **18 µA** in deep sleep mode.

### **Software & Compatibility**
*   **Programming:** Fully supports **Arduino** (Adafruit GFX compatible) and **MicroPython**.
*   **Open Source:** Both hardware and software are open-source.

### **Physical Dimensions**
*   **Board Only (without EPD):** 131.5 × 105.5 × 10 mm (5.2 × 4.2 × 0.4 inches).
*   **With Enclosure:** 140 × 119.3 × 13.6 mm (5.5 × 4.7 × 0.5 inches).

### **Available Configurations**
*   **Standard:** Inkplate 6COLOR display board.
*   **Board Only:** Without the e-paper display (for custom integrations).
*   **With Enclosure:** Includes a 3D-printed protective case.
*   **Full Kit:** Includes the display, enclosure, and a 1200mAh battery.

---

### **Arduino Library Usage**
The **Inkplate** Arduino library allows you to control the display using the onboard ESP32. It supports Adafruit GFX functions for drawing and text.

#### Setup Requirements
1. **Board URL:** Add `https://soldered.com/package_soldered_index.json` to your Arduino IDE Preferences.
2. **Library Installation:** Install the **"Inkplate"** library via the Arduino Library Manager.
3. **Board Selection:** Select **Tools > Board > Soldered Inkplate Boards > Soldered Inkplate 6COLOR**.

#### Basic Code Example
To update the display, you manipulate an internal buffer and then push it to the screen using `display.display()`.

```cpp
#include "Inkplate.h"      // Include the main library
Inkplate display;          // Create the display object

void setup() {
  display.begin();         // Initialize the display
  display.clearDisplay();  // Clear the internal buffer (sets it to white)

  // Set text properties
  display.setTextSize(4);
  display.setTextColor(INKPLATE_BLACK);
  display.setCursor(10, 10);
  
  // Print content to the buffer
  display.print("Hello Inkplate!");

  // Draw a colored shape
  display.fillCircle(100, 100, 50, INKPLATE_RED);

  // Push the buffer to the physical screen
  display.display(); 
}

void loop() {
  // Nothing to do here
}
```

#### Supported Colors
The Inkplate 6COLOR supports seven primary colors defined as constants:
*   `INKPLATE_BLACK`
*   `INKPLATE_WHITE`
*   `INKPLATE_RED`
*   `INKPLATE_BLUE`
*   `INKPLATE_YELLOW`
*   `INKPLATE_ORANGE`
*   `INKPLATE_GREEN`

#### Key Functions
*   **`display.begin()`**: Initializes the ESP32 pins, SPI, and allocates the frame buffer.
*   **`display.display()`**: Sends the current buffer to the physical e-paper screen. Note that color e-paper displays take time to refresh.
*   **`display.clearDisplay()`**: Resets the internal buffer to white.
*   **`display.drawImage()`**: Displays images from the web or an SD card (supports .bmp files).
