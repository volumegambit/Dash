plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "app.dash.core.auth"
  compileSdk = 36
  defaultConfig {
    minSdk = 26
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
  api(project(":core:contracts"))
  api(project(":core:security"))
  api(project(":core:network"))
  api(project(":core:database"))
  api(libs.kotlinx.coroutines.core)
  api(libs.okhttp)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.browser)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.okhttp.mockwebserver)
  testImplementation(libs.robolectric)
}
