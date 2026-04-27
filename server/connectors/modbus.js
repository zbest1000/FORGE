// Modbus TCP write helper.
//
// Default mode is audited/simulated so local development and tests never touch
// a PLC. Set FORGE_MODBUS_WRITE_MODE=live to perform real TCP writes.

export async function writeModbusValue(device, register, { rawValue, value }) {
  const raw = rawValue == null ? Number(value) / Number(register.scale || 1) : Number(rawValue);
  if (!Number.isFinite(raw)) throw Object.assign(new Error("numeric rawValue or value required"), { statusCode: 400 });

  if ((process.env.FORGE_MODBUS_WRITE_MODE || "simulated") !== "live") {
    return { mode: "simulated", rawValue: raw, applied: true };
  }

  const mod = await import("modbus-serial");
  const ModbusRTU = mod.default || mod;
  const client = new ModbusRTU();
  try {
    await client.connectTCP(device.host, { port: Number(device.port || 502) });
    client.setID(Number(device.unit_id || 1));
    if (Number(register.function_code) === 1 || register.data_type === "bool") {
      await client.writeCoil(Number(register.address), Boolean(raw));
    } else {
      await client.writeRegister(Number(register.address), Math.round(raw));
    }
    return { mode: "live", rawValue: raw, applied: true };
  } finally {
    try { client.close(); } catch { /* noop */ }
  }
}
