import { render, screen } from '@testing-library/react'
import { AppScreenshot } from '../AppScreenshot'

describe('AppScreenshot', () => {
  it('renders the section heading', () => {
    render(<AppScreenshot />)
    expect(screen.getByRole('heading', { name: /mission control/i })).toBeInTheDocument()
  })

  it('renders a placeholder', () => {
    render(<AppScreenshot />)
    expect(screen.getByTestId('screenshot-placeholder')).toBeInTheDocument()
  })
})
