# kotlinx.serialization: keep generated serializers for the api models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class org.jaiaditya.phonemail.data.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class org.jaiaditya.phonemail.data.**$$serializer { *; }

# Socket.IO / engine.io use reflection-free OkHttp; silence optional platform warnings.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
