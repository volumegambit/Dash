import { render, screen } from '@testing-library/react'
import { HowItWorks } from '../HowItWorks'

describe('HowItWorks', () => {
  it('renders the section heading', () => {
    render(<HowItWorks />)
    expect(screen.getByRole('heading', { name: /how it works/i })).toBeInTheDocument()
  })

  it('renders all four architecture nodes', () => {
    render(<HowItWorks />)
    expect(screen.getByText('Chat Platforms')).toBeInTheDocument()
    expect(screen.getByText('Gateway')).toBeInTheDocument()
    expect(screen.getByText('Agent Server')).toBeInTheDocument()
    expect(screen.getByText('Mission Control')).toBeInTheDocument()
  })
})
