import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmExtension

plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.kotlin.android) apply false
  alias(libs.plugins.kotlin.jvm) apply false
  alias(libs.plugins.kotlin.serialization) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.kapt) apply false
}

subprojects {
  pluginManager.withPlugin("org.jetbrains.kotlin.android") {
    extensions.configure<KotlinAndroidExtension> {
      compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
  }
  pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
    extensions.configure<KotlinJvmExtension> {
      compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
  }
}
