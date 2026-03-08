import { Nav } from '@/components/Nav'
import { Hero } from '@/components/Hero'
import { Features } from '@/components/Features'
import { HowItWorks } from '@/components/HowItWorks'
import { AppScreenshot } from '@/components/AppScreenshot'
import { QuickStart } from '@/components/QuickStart'
import { Community } from '@/components/Community'
import { Footer } from '@/components/Footer'

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <AppScreenshot />
      <QuickStart />
      <Community />
      <Footer />
    </main>
  )
}
