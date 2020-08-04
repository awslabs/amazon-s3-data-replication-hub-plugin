import setuptools

setuptools.setup(
    name="aws-data-replication-component-s3",
    version="v0.1.0",

    description="Replication Component for AWS Data Replication Hub",

    author="huangzb@amazon.com",

    package_dir={"": "./"},

    install_requires=[
        "boto3"
    ],

    python_requires=">=3.6",

    classifiers=[
        "Development Status :: 4 - Beta",

        "Intended Audience :: Developers",

        "License :: OSI Approved :: Apache Software License",

        "Programming Language :: JavaScript",
        "Programming Language :: Python :: 3 :: Only",
        "Programming Language :: Python :: 3.6",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",

        "Topic :: Software Development :: Code Generators",
        "Topic :: Utilities",

        "Typing :: Typed",
    ],
)
