public class RuntimeSmoke {
  public static void main(String[] args) throws Exception {
    // Reflection lets the probe compile on the runner's JDK 17, and run on
    // the bundled JRE 25. Generate a local key to exercise the actual JNI ABI.
    Object key = Class.forName("org.signal.libsignal.protocol.IdentityKeyPair").getMethod("generate").invoke(null);
    if (key == null) throw new IllegalStateException("No local identity key");
    System.out.println("PASS: libsignal JNI loaded and generated a temporary local identity key");
  }
}
