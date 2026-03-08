import { render, screen } from '@testing-library/react'
import { Hero } from '../Hero'

describe('Hero', () => {
  it('renders the headline', () => {
    render(<Hero />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your AI Team, Always On')
  })

  it('renders the Download CTA', () => {
    render(<Hero />)
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument()
  })

  it('renders the Docs CTA', () => {
    render(<Hero />)
    expect(screen.getByRole('link', { name: /read the docs/i })).toBeInTheDocument()
  })

  it('renders the terminal window', () => {
    render(<Hero />)
    expect(screen.getByRole('region', { name: /terminal/i })).toBeInTheDocument()
  })
})
