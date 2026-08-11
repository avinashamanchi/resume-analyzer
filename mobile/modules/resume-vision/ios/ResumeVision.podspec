Pod::Spec.new do |s|
  s.name             = 'ResumeVision'
  s.version          = '1.0.0'
  s.summary          = 'Private on-device scanned PDF text recognition for Resume.AI.'
  s.description      = 'An Expo module that uses Apple PDFKit and Vision without transmitting document data.'
  s.platforms        = { :ios => '16.4' }
  s.source           = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks       = 'PDFKit', 'Vision'
  s.source_files     = '**/*.{h,m,mm,swift}'
  s.swift_version    = '5.9'
end
