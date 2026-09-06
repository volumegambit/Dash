import com.android.build.api.dsl.ManagedVirtualDevice

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "app.dash.core.security"
  compileSdk = 36
  defaultConfig {
    minSdk = 26
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions {
    unitTests.isIncludeAndroidResources = true
    managedDevices.devices {
      create<ManagedVirtualDevice>("phoneApi27") {
        device = "Pixel 2"
        apiLevel = 27
        systemImageSource = "aosp"
      }
    }
  }
}

dependencies {
  api(project(":core:contracts"))
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.tink.android)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.espresso.core)
  androidTestImplementation(libs.kotlinx.coroutines.test)
}
