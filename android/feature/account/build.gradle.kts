import com.android.build.api.dsl.ManagedVirtualDevice

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "app.dash.feature.account"
  compileSdk = 36
  defaultConfig {
    minSdk = 26
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  buildFeatures { compose = true }
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
  implementation(project(":core:contracts"))
  implementation(project(":core:database"))
  implementation(project(":core:network"))
  implementation(project(":core:sync"))
  implementation(project(":core:designsystem"))
  implementation(libs.kotlinx.coroutines.core)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.savedstate)
  testImplementation(project(":core:testing"))
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.turbine)
  androidTestImplementation(platform(libs.androidx.compose.bom))
  androidTestImplementation(project(":core:testing"))
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.espresso.core)
  androidTestImplementation(libs.kotlinx.coroutines.test)
  debugImplementation(libs.androidx.compose.ui.test.manifest)
}
