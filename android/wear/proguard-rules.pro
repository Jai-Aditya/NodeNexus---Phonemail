# kotlinx.serialization: keep generated serializers for the api models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class org.jaiaditya.phonemail.wear.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class org.jaiaditya.phonemail.wear.**$$serializer { *; }

-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
