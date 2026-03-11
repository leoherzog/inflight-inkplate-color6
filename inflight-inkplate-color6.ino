#include "Inkplate.h"
#include <NimBLEDevice.h>
#include "esp_task_wdt.h"
#include "esp_pm.h"
#include "esp_wifi.h"

// BLE UUIDs (service UUID from PLAN.md, characteristic UUIDs derived)
#define SERVICE_UUID   "12345678-1234-5678-1234-56789abcdef0"
#define CMD_CHAR_UUID  "12345678-1234-5678-1234-56789abcdef1"
#define DATA_CHAR_UUID "12345678-1234-5678-1234-56789abcdef2"

// Image buffer: 600x448 at 2 pixels per byte = 134,400 bytes
#define IMG_BUF_SIZE (600 * 448 / 2)
#define CHUNK_SIZE 500

// Battery Service (standard BLE GATT)
#define BATTERY_SERVICE_UUID    "180F"
#define BATTERY_LEVEL_CHAR_UUID "2A19"
#define BATTERY_READ_INTERVAL   120000 // ms between battery reads
// Li-Ion voltage range (single cell)
#define BATT_V_MIN 3.0
#define BATT_V_MAX 4.2

Inkplate display;
uint8_t *imgBuffer = nullptr;
volatile uint32_t bytesReceived = 0;
volatile bool displayPending = false;
NimBLEServer *pServer = nullptr;
NimBLECharacteristic *pBattChar = nullptr;
unsigned long lastBatteryRead = 0;

// --- Battery Helper ---

uint8_t voltageToBatteryPercent(double voltage) {
    if (voltage <= BATT_V_MIN) return 0;
    if (voltage >= BATT_V_MAX) return 100;
    return (uint8_t)((voltage - BATT_V_MIN) / (BATT_V_MAX - BATT_V_MIN) * 100);
}

void updateBatteryLevel() {
    double voltage = display.readBattery();
    uint8_t level = voltageToBatteryPercent(voltage);
    pBattChar->setValue(&level, 1);
    pBattChar->notify();
    Serial.printf("Battery: %.2fV (%u%%)\n", voltage, level);
}

// --- BLE Server Callbacks ---

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
        Serial.printf("Client connected: %s\n", connInfo.getAddress().toString().c_str());
        NimBLEDevice::startAdvertising();
    }

    void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override {
        Serial.printf("Client disconnected (reason: %d)\n", reason);
        NimBLEDevice::startAdvertising();
    }

    void onMTUChange(uint16_t MTU, NimBLEConnInfo &connInfo) override {
        Serial.printf("MTU updated: %u\n", MTU);
    }
};

// --- CMD Characteristic Callback (START=0x01, END=0x02) ---

class CmdCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
        NimBLEAttValue val = pCharacteristic->getValue();
        if (val.size() < 1) return;

        uint8_t cmd = val.data()[0];

        if (cmd == 0x01) {
            // START: allocate/clear receive buffer
            Serial.println("START: Receiving image...");
            if (imgBuffer == nullptr) {
                imgBuffer = (uint8_t *)ps_malloc(IMG_BUF_SIZE);
            }
            if (imgBuffer != nullptr) {
                memset(imgBuffer, 0x11, IMG_BUF_SIZE);
                bytesReceived = 0;
            } else {
                Serial.println("ERROR: Failed to allocate PSRAM buffer");
            }
        } else if (cmd == 0x02) {
            // END: copy buffer to display and refresh
            Serial.printf("END: Received %u / %u bytes. Queuing display...\n", bytesReceived, IMG_BUF_SIZE);
            if (imgBuffer != nullptr && bytesReceived > 0) {
                // Reverse buffer to fix 180° rotation (panel origin is bottom-right)
                // Each byte = 2 pixels (high nibble | low nibble), so also swap nibbles
                for (uint32_t i = 0; i < IMG_BUF_SIZE; i++) {
                    uint8_t b = imgBuffer[IMG_BUF_SIZE - 1 - i];
                    display.DMemory4Bit[i] = (b << 4) | (b >> 4);
                }
                // Free receive buffer to save ~134KB PSRAM between transfers
                free(imgBuffer);
                imgBuffer = nullptr;
                displayPending = true;
            }
        }
    }
};

// --- DATA Characteristic Callback (chunked pixel data) ---

class DataCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
        NimBLEAttValue val = pCharacteristic->getValue();
        if (val.size() < 3 || imgBuffer == nullptr) return;

        const uint8_t *data = val.data();
        // 2-byte little-endian chunk index, then up to CHUNK_SIZE bytes of pixel data
        uint16_t chunkIndex = data[0] | (data[1] << 8);
        uint16_t dataLen = val.size() - 2;
        uint32_t offset = (uint32_t)chunkIndex * CHUNK_SIZE;

        if (offset + dataLen <= IMG_BUF_SIZE) {
            memcpy(imgBuffer + offset, data + 2, dataLen);
            bytesReceived += dataLen;
        } else {
            Serial.printf("WARN: chunk %u overflows buffer (offset %u + len %u > %u)\n",
                          chunkIndex, offset, dataLen, IMG_BUF_SIZE);
        }
    }
};

// --- Setup ---

void setup() {
    Serial.begin(115200);

    // Disable WiFi radio to save power (we only use BLE)
    esp_wifi_stop();
    esp_wifi_deinit();

    // Lower CPU frequency: 80MHz is sufficient for BLE, saves ~50% power vs 240MHz
    setCpuFrequencyMhz(80);

    // Enable automatic light sleep with power management
    esp_pm_config_esp32_t pm_config = {
        .max_freq_mhz = 80,
        .min_freq_mhz = 10,
        .light_sleep_enable = true
    };
    esp_pm_configure(&pm_config);

    // Initialize display (skip clear/refresh to preserve last image across power cycles)
    display.begin();
    Serial.println("Display ready.");

    // Pre-allocate receive buffer in PSRAM
    imgBuffer = (uint8_t *)ps_malloc(IMG_BUF_SIZE);
    if (imgBuffer == nullptr) {
        Serial.println("ERROR: Failed to allocate PSRAM buffer");
    }

    // Initialize BLE with unique name derived from MAC address
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char bleName[24];
    snprintf(bleName, sizeof(bleName), "Inkplate6C-%02X%02X", mac[4], mac[5]);
    NimBLEDevice::init(bleName);
    NimBLEDevice::setMTU(517);

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    NimBLEService *pService = pServer->createService(SERVICE_UUID);

    // CMD: acknowledged writes for START/END commands
    NimBLECharacteristic *pCmdChar = pService->createCharacteristic(
        CMD_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE);
    pCmdChar->setCallbacks(new CmdCallbacks());

    // DATA: write-without-response for high-speed chunked transfer
    NimBLECharacteristic *pDataChar = pService->createCharacteristic(
        DATA_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE_NR,
        512);
    pDataChar->setCallbacks(new DataCallbacks());

    pService->start();

    // Battery Service (standard BLE GATT profile)
    NimBLEService *pBattService = pServer->createService(BATTERY_SERVICE_UUID);
    pBattChar = pBattService->createCharacteristic(
        BATTERY_LEVEL_CHAR_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    uint8_t initLevel = voltageToBatteryPercent(display.readBattery());
    pBattChar->setValue(&initLevel, 1);
    pBattService->start();

    NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();

    // Manually split adv data: UUID in advertisement, name in scan response.
    // A 128-bit UUID (18B) + name (17B) exceeds the 31-byte adv packet limit,
    // causing Chrome to show "Unknown or Unsupported Device" in the picker.
    NimBLEAdvertisementData advData;
    advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
    advData.addServiceUUID(SERVICE_UUID);
    pAdvertising->setAdvertisementData(advData);

    NimBLEAdvertisementData scanRsp;
    scanRsp.setName(bleName);
    pAdvertising->setScanResponseData(scanRsp);

    // Increase advertising interval: default ~100ms is very aggressive.
    // 1000ms (1600 * 0.625ms) saves significant power while still being discoverable.
    pAdvertising->setMinInterval(1600);  // 1000ms
    pAdvertising->setMaxInterval(2400);  // 1500ms
    pAdvertising->start();

    Serial.println("BLE advertising started.");
}

void loop() {
    if (displayPending) {
        displayPending = false;
        Serial.println("Refreshing display...");
        esp_task_wdt_deinit();
        display.display();
        esp_task_wdt_init(5, true);
        Serial.println("Display updated.");
    }

    unsigned long now = millis();
    if (now - lastBatteryRead >= BATTERY_READ_INTERVAL) {
        lastBatteryRead = now;
        updateBatteryLevel();
    }

    delay(500);
}
